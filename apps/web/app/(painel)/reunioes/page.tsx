import Link from "next/link";
import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient, getMe, isManager } from "@/lib/supabase/server";
import { addDays, formatDateTime, localDay, localToDate } from "@/lib/time";
import { DayNav } from "./DayNav";
import { ActionsCell, RequestRow, StatusCell, type Pedido } from "./Cells";

export const metadata = { title: "Reuniões — Painel SDR" };

interface Row {
  id: string; starts_at: string; ends_at: string; status: string; title: string | null; lead_name: string | null; company: string | null;
  carousel: string | null; brand: string | null; closer: string | null; sdr: string | null; fora_do_padrao: boolean; google_state: string | null; permissao: string;
}

const FILTERS = [["all", "Todas"], ["agendada", "Agendadas"], ["done", "Realizadas"], ["noshow", "No show"], ["cancelada", "Canceladas"], ["problem", "Com problema"]] as const;
const BRAND: Record<string, string> = { poli: "Poli", chatshub: "ChatsHub" };
const problem = (r: Row) => r.status === "agendada" && !!r.google_state && r.google_state !== "ok";
function match(r: Row, f: string) {
  if (f === "all") return true;
  if (f === "problem") return problem(r);
  if (problem(r)) return false;
  if (f === "done") return r.status === "validada" || r.status === "invalidada";
  return r.status === f;
}

// Lista de reuniões por dia (design/Reunioes.dc.html). Cada um vê só o que o banco devolve para ele.
export default async function ReunioesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const me = await getMe();
  if (!me) redirect("/");
  const sp = await searchParams;
  const today = localDay(new Date());
  const day = sp.dia && /^\d{4}-\d{2}-\d{2}$/.test(sp.dia) ? sp.dia : today;
  const filter = FILTERS.some(([k]) => k === sp.f) ? sp.f! : "all";
  const db = (await createClient()).schema("painel");
  const { data, error } = await db.rpc("reunioes_lista", { p_from: localToDate(day).toISOString(), p_to: localToDate(addDays(day, 1)).toISOString() });
  if (error) throw new Error(`Não foi possível ler as reuniões: ${error.message}`);
  const all = (data ?? []) as Row[];

  // Detalhes que a lista não traz (a permissão já foi conferida pelo banco: só ids que ele devolveu).
  const ids = all.map((r) => r.id);
  const adm = createAdminClient().schema("painel");
  const [extra, aprovados, pedidosRes] = await Promise.all([
    ids.length ? adm.from("meetings").select("id, assigned_by, meet_url").in("id", ids) : Promise.resolve({ data: [] }),
    ids.length ? adm.from("closer_swap_requests").select("meeting_id, status").in("meeting_id", ids).in("status", ["aprovado", "pendente"]) : Promise.resolve({ data: [] }),
    me.role === "closer" ? Promise.resolve({ data: [] }) : db.rpc("pedidos_troca", { p_status: "pendente" }),
  ]);
  const ex = new Map(((extra.data ?? []) as { id: string; assigned_by: string | null; meet_url: string | null }[]).map((e) => [e.id, e]));
  const reqs = (aprovados.data ?? []) as { meeting_id: string; status: string }[];
  const pedidos = (pedidosRes.data ?? []) as Pedido[];

  const carousels = [...new Set(all.map((r) => r.carousel && `${BRAND[r.brand ?? ""] ?? ""} · ${r.carousel}`).filter(Boolean))] as string[];
  const sdrs = [...new Set(all.map((r) => r.sdr).filter(Boolean))] as string[];
  const closers = [...new Set(all.map((r) => r.closer).filter(Boolean))] as string[];
  const q = (sp.q ?? "").trim().toLowerCase();
  const rows = all.filter((r) => match(r, filter)
    && (!sp.c || `${BRAND[r.brand ?? ""] ?? ""} · ${r.carousel}` === sp.c)
    && (!sp.s || r.sdr === sp.s) && (!sp.k || r.closer === sp.k)
    && (!q || `${r.company ?? ""} ${r.lead_name ?? ""}`.toLowerCase().includes(q)));
  const link = (patch: Record<string, string | null>) => {
    const p = new URLSearchParams(Object.entries({ ...sp, ...patch }).filter(([, v]) => v) as [string, string][]);
    return `/reunioes${p.size ? `?${p}` : ""}`;
  };
  const weekday = new Date(`${day}T12:00:00Z`).toLocaleDateString("pt-BR", { weekday: "long", timeZone: "UTC" });
  const now = Date.now();

  return (
    <main className="page">
      <div className="page-head">
        <h1 className="title">Reuniões</h1>
        <span className="spacer" />
        <DayNav day={day} today={today} prev={addDays(day, -1)} next={addDays(day, 1)} />
        {(me.role === "sdr" || isManager(me)) && <Link href="/agendar" className="btn primary" style={{ fontWeight: 600 }}>Agendar reunião</Link>}
      </div>
      {sp.mudou && <div className="ok" role="status">Horário alterado. O convite foi atualizado na agenda.</div>}

      {isManager(me) && pedidos.length > 0 && (
        <section className="rn-req" aria-labelledby="sec-req">
          <div className="rn-req-head">
            <h2 id="sec-req" className="card-title">Pedidos de troca de closer</h2>
            <span className="ag-pill">{pedidos.length} aguardando decisão</span>
            <span className="spacer" />
            <span className="ag-hint">Responsável: gestor de SDR. Qualquer gestor ou admin pode decidir. A reunião segue com o closer atual até a decisão.</span>
          </div>
          {pedidos.map((p) => <RequestRow key={p.id} p={p} />)}
        </section>
      )}

      <form className="toolbar" action="/reunioes">
        <input type="hidden" name="dia" value={day} />
        <div role="group" aria-label="Filtrar por situação" className="group">
          {FILTERS.map(([k, l]) => (
            <Link key={k} href={link({ f: k === "all" ? null : k })} className="ag-chip" aria-pressed={filter === k}
              style={{ display: "inline-flex", alignItems: "center", textDecoration: "none" }}>
              {l} {all.filter((r) => match(r, k)).length}
            </Link>
          ))}
        </div>
        <span className="spacer" />
        {filter !== "all" && <input type="hidden" name="f" value={filter} />}
        <select name="c" className="field" aria-label="Carrossel" defaultValue={sp.c ?? ""}>
          <option value="">Todos os carrosséis</option>
          {carousels.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select name="s" className="field" aria-label="SDR" defaultValue={sp.s ?? ""}>
          <option value="">Todos os SDRs</option>
          {sdrs.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        {me.role !== "closer" && (
          <select name="k" className="field" aria-label="Closer" defaultValue={sp.k ?? ""}>
            <option value="">Todos os closers</option>
            {closers.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        )}
        <label className="sr-only" htmlFor="q">Buscar reunião</label>
        <input id="q" name="q" type="search" className="field" style={{ width: 260 }} placeholder="Buscar lead ou empresa..." defaultValue={sp.q ?? ""} />
        <button type="submit" className="btn">Filtrar</button>
      </form>

      <div className="rn-table">
        <div className="table-wrap">
          <table>
            <thead><tr>
              <th scope="col" style={{ width: 70 }}>Hora</th><th scope="col">Lead</th><th scope="col">Carrossel</th><th scope="col">SDR</th>
              <th scope="col">Closer</th><th scope="col">Situação</th><th scope="col" style={{ textAlign: "right", paddingRight: 16 }}>Ações</th>
            </tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={7} className="muted">Nenhuma reunião {filter === "all" ? "neste dia" : "com este filtro neste dia"}.</td></tr>}
              {rows.map((r) => {
                const e = ex.get(r.id);
                const req = reqs.filter((x) => x.meeting_id === r.id);
                const assigned = req.some((x) => x.status === "aprovado") ? "Trocado a pedido do SDR"
                  : e?.assigned_by === "manual" ? "Trocado por um gestor" : "Pelo carrossel";
                return (
                  <tr key={r.id}>
                    <td className="rn-time">{formatDateTime(r.starts_at).slice(6)}</td>
                    <td><div className="rn-stack"><Link href={`/reuniao/${r.id}`} style={{ fontWeight: 600, textDecoration: "none" }}>{r.company ?? r.title ?? "—"}</Link>
                      <span className="ag-hint">{r.lead_name ?? "—"}{r.fora_do_padrao ? " · fora do horário padrão" : ""}</span></div></td>
                    <td><div className="rn-stack"><span>{r.carousel ?? "—"}</span><span className="ag-hint">{BRAND[r.brand ?? ""] ?? ""}</span></div></td>
                    <td>{r.sdr ?? "—"}</td>
                    <td><div className="rn-stack"><span>{r.closer ?? "—"}</span><span className="ag-hint">{assigned}</span>
                      {req.some((x) => x.status === "pendente") && <span className="ag-warn">Troca pedida</span>}</div></td>
                    <td><StatusCell id={r.id} status={r.status} permissao={r.permissao} problema={problem(r) ? r.google_state : null} company={r.company ?? "lead"} /></td>
                    <td><ActionsCell id={r.id} status={r.status} futura={Date.parse(r.starts_at) > now} permissao={r.permissao} brand={r.brand}
                      meetUrl={e?.meet_url ?? null} pedidoPendente={req.some((x) => x.status === "pendente")} company={r.company ?? "lead"} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="rn-footer">
          {weekday.charAt(0).toUpperCase() + weekday.slice(1)}, {day.split("-").reverse().join("/")} · mostrando {rows.length} de {all.length} {all.length === 1 ? "reunião" : "reuniões"} do dia
        </div>
      </div>
    </main>
  );
}
