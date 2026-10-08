import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient, getMe } from "@/lib/supabase/server";
import { addDays, formatDateTime, formatTime, localDay, localToDate } from "@/lib/time";
import { StatusActions } from "./StatusActions";
import { FilaPedidos, RowTrocas, type Pedido } from "./Trocas";

export const metadata = { title: "Reuniões — Painel SDR" };

const STATUS: Record<string, string> = { agendada: "Agendada", validada: "Validada", noshow: "No show", invalidada: "Invalidada", cancelada: "Cancelada" };
const AVISO: Record<string, string> = { removida: "Removida no Google", recusada_lead: "Lead recusou no Google", recusada_closer: "Closer recusou no Google" };

interface Row {
  id: string; starts_at: string; ends_at: string; status: string; title: string | null; lead_name: string | null; company: string | null;
  carousel: string | null; brand: string | null; closer: string | null; sdr: string | null; fora_do_padrao: boolean; google_state: string | null; permissao: string;
}

export default async function ReunioesPage({ searchParams }: { searchParams: Promise<{ ver?: string; mudou?: string }> }) {
  const me = await getMe();
  if (!me) redirect("/");
  const sp = await searchParams;
  const today = localDay(new Date());
  const passadas = sp.ver === "passadas";
  const [from, to] = passadas ? [addDays(today, -30), today] : [today, addDays(today, 31)];
  const { data, error } = await (await createClient()).schema("painel").rpc("reunioes_lista", {
    p_from: localToDate(from).toISOString(), p_to: localToDate(to).toISOString(),
  });
  if (error) throw new Error(`Não foi possível ler as reuniões: ${error.message}`);
  const rows = (data ?? []) as Row[];
  const pedidosRes = me.role === "closer" ? { data: [] } : await (await createClient()).schema("painel").rpc("pedidos_troca", { p_status: me.role === "sdr" ? null : "pendente" });
  const pedidos = (pedidosRes.data ?? []) as Pedido[];
  const STATUS_PEDIDO: Record<string, string> = { pendente: "pendente", aprovado: "aprovado", recusado: "recusado", expirado: "expirado" };
  const agora = Date.now();
  const avisos = rows.filter((r) => r.status === "agendada" && r.google_state && r.google_state !== "ok");

  return (
    <main className="page">
      <div className="page-head">
        <h1 className="title">Reuniões</h1>
        <span className="spacer" />
        <div className="group">
          <Link href="/reunioes" className={`btn small${passadas ? "" : " primary"}`} aria-pressed={!passadas}>Próximas</Link>
          <Link href="/reunioes?ver=passadas" className={`btn small${passadas ? " primary" : ""}`} aria-pressed={passadas}>Últimos 30 dias</Link>
        </div>
      </div>
      {sp.mudou && <div className="ok" role="status">Horário alterado. O convite foi atualizado na agenda.</div>}
      {avisos.length > 0 && (
        <div className="alert" role="alert">
          {avisos.length === 1 ? "1 reunião precisa" : `${avisos.length} reuniões precisam`} de atenção: o Google avisou mudança feita fora do painel. Confira abaixo.
        </div>
      )}
      {me.role !== "sdr" && me.role !== "closer" && pedidos.length > 0 && <FilaPedidos pedidos={pedidos} />}
      {me.role === "sdr" && pedidos.length > 0 && (
        <section className="card" style={{ gap: 6 }} aria-labelledby="meus-pedidos">
          <h2 id="meus-pedidos" className="card-title">Seus pedidos de troca de closer</h2>
          {pedidos.slice(0, 10).map((p) => (
            <span key={p.id}>{p.lead_name ?? "—"} · {formatDateTime(p.starts_at)} · <strong>{STATUS_PEDIDO[p.status]}</strong>
              {p.status === "aprovado" && p.para ? ` · novo closer ${p.para}` : ""}{p.decision_note ? ` · ${p.decision_note}` : ""}</span>
          ))}
        </section>
      )}
      <div className="card">
        <div className="table-wrap">
          <table>
            <thead><tr>
              <th scope="col">Quando</th><th scope="col">Reunião</th><th scope="col">Lead</th><th scope="col">Carrossel</th>
              <th scope="col">Closer</th><th scope="col">SDR</th><th scope="col">Situação</th><th scope="col"><span className="sr-only">Ações</span></th>
            </tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={8} className="muted">Nenhuma reunião {passadas ? "nos últimos 30 dias" : "marcada a partir de hoje"}.</td></tr>}
              {rows.map((r) => (
                <tr key={r.id}>
                  <td><div className="cell-stack"><span>{formatDateTime(r.starts_at)}–{formatTime(new Date(r.ends_at))}</span>
                    {r.fora_do_padrao && <span className="muted">fora do horário padrão</span>}</div></td>
                  <td><Link href={`/reuniao/${r.id}`}>{r.title ?? "Reunião"}</Link></td>
                  <td>{r.lead_name ?? "—"}</td>
                  <td>{r.carousel ?? "—"}</td>
                  <td>{r.closer ?? "—"}</td>
                  <td>{r.sdr ?? "—"}</td>
                  <td><div className="cell-stack"><span>{STATUS[r.status] ?? r.status}</span>
                    {r.status === "agendada" && r.google_state && r.google_state !== "ok" && <strong style={{ color: "var(--danger, #e5484d)" }}>{AVISO[r.google_state]}</strong>}</div></td>
                  <td><div className="cell-stack" style={{ gap: 6 }}>
                    <StatusActions id={r.id} status={r.status} permissao={r.permissao} aviso={r.status === "agendada" ? r.google_state : null} />
                    <RowTrocas id={r.id} status={r.status} futura={Date.parse(r.starts_at) > agora} permissao={r.permissao} brand={r.brand} />
                  </div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
