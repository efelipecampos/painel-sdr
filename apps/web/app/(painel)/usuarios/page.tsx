import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient, getMe } from "@/lib/supabase/server";
import { ActiveSwitch } from "./ActiveSwitch";

export const metadata = { title: "Usuários — Painel SDR" };

interface Usuario {
  sdr_id: string | null; profile_id: string | null; name: string; email: string | null;
  papel: string; is_bot: boolean; tem_login: boolean; active: boolean; agenda: string | null;
}

const PAPEL: Record<string, string> = { admin: "Admin", gestor: "Gestor", sdr: "SDR", closer: "Closer" };
const ROLES = [
  ["Admin", "Vê tudo e muda configurações, carrosséis e usuários."],
  ["Gestor", "Vê o painel e as reuniões de todos. Ajusta pesos e aprova pedidos de troca de closer."],
  ["SDR", "Vê só os próprios chats, números e reuniões. Agenda reuniões."],
  ["Closer", "Recebe reuniões na agenda do Google. Vê e marca a situação das próprias reuniões no painel."],
];
const BRAND: Record<string, string> = { poli: "Poli", chatshub: "ChatsHub" };
const ini = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();

// Lista da equipe (design/Usuarios.dc.html). Desativar tira o acesso e tira das listas e carrosséis, sem apagar dados.
export default async function UsuariosPage({ searchParams }: { searchParams: Promise<{ p?: string; erro?: string; salvo?: string }> }) {
  const me = await getMe();
  if (!me?.canManageUsers) redirect("/");
  const sp = await searchParams;
  const db = (await createClient()).schema("painel");
  const [{ data, error }, members, arq] = await Promise.all([
    db.rpc("usuarios"),
    db.from("carousel_members").select("closer_id, active, carousels(name, brand, active)"),
    db.from("settings").select("value").eq("key", "google_archive_calendar_id").maybeSingle(),
  ]);
  if (error) throw new Error(`Não foi possível ler os usuários: ${error.message}`);
  const team = ((data ?? []) as Usuario[]).filter((u) => !u.is_bot && u.papel in PAPEL);
  const filter = sp.p && sp.p in PAPEL ? sp.p : "all";
  const rows = team.filter((u) => filter === "all" || u.papel === filter);
  const carrosseis = new Map<string, { name: string; brand: string }[]>();
  for (const m of (members.data ?? []) as unknown as { closer_id: string; active: boolean; carousels: { name: string; brand: string; active: boolean } | null }[]) {
    if (!m.active || !m.carousels?.active) continue;
    carrosseis.set(m.closer_id, [...(carrosseis.get(m.closer_id) ?? []), m.carousels]);
  }
  const arquivo = String(arq.data?.value ?? "").trim();

  return (
    <main className="page">
      <div className="page-head"><h1 className="title">Usuários</h1></div>
      {sp.salvo && <div className="ok" role="status">{sp.salvo === "on" ? "Usuário reativado." : "Usuário desativado."}</div>}
      {sp.erro && <div className="alert" role="alert">{sp.erro}</div>}

      <div className="us-roles">
        {ROLES.map(([t, d]) => (
          <div key={t} className="us-role"><span style={{ fontSize: 14, lineHeight: "22px", fontWeight: 600 }}>{t}</span><span className="ag-hint">{d}</span></div>
        ))}
      </div>

      <div className="toolbar">
        <div role="group" aria-label="Filtrar por papel" className="group">
          {[["all", "Todos"], ["admin", "Admin"], ["gestor", "Gestor"], ["sdr", "SDR"], ["closer", "Closer"]].map(([k, l]) => (
            <Link key={k} href={k === "all" ? "/usuarios" : `/usuarios?p=${k}`} className="ag-chip" aria-pressed={filter === k}
              style={{ display: "inline-flex", alignItems: "center", textDecoration: "none" }}>
              {l} {team.filter((u) => k === "all" || u.papel === k).length}
            </Link>
          ))}
        </div>
        <span className="spacer" />
        <span className="ag-hint">
          Agenda de arquivo (recebe reuniões canceladas e no show): {arquivo ? "conectada na conta do admin" : "não cadastrada"}
          {me.role === "admin" && <> · <Link href="/configuracoes">trocar</Link></>}
        </span>
      </div>

      <div className="rn-table">
        <div className="table-wrap">
          <table>
            <thead><tr>
              <th scope="col">Usuário</th><th scope="col">Papel</th><th scope="col">Empresa</th><th scope="col">Carrosséis</th>
              <th scope="col">Agenda do Google</th><th scope="col">Login</th><th scope="col">Ativo</th>
            </tr></thead>
            <tbody>
              {rows.map((u) => {
                const cs = u.sdr_id ? carrosseis.get(u.sdr_id) ?? [] : [];
                const brands = [...new Set(cs.map((c) => BRAND[c.brand]))];
                const self = u.profile_id === me.id;
                return (
                  <tr key={`${u.sdr_id}-${u.profile_id}`} style={{ opacity: u.active ? 1 : 0.55, height: 60 }}>
                    <td><div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <div className="us-avatar">{ini(u.name)}</div>
                      <div className="rn-stack"><span style={{ fontWeight: 600 }}>{u.name}</span><span className="ag-hint">{u.email ?? "—"}</span></div>
                    </div></td>
                    <td>{PAPEL[u.papel]}</td>
                    <td>{u.papel === "closer" ? (brands.length === 2 ? "Poli e ChatsHub" : brands[0] ?? "—") : u.papel === "sdr" ? "Poli e ChatsHub" : "—"}</td>
                    <td>{u.papel === "closer" ? (
                      <div className="rn-stack">
                        <span>{cs.length ? cs.map((c) => `${BRAND[c.brand]} · ${c.name}`).join(", ") : "Nenhum"}</span>
                        <Link href="/carrosseis" className="ag-hint" style={{ fontWeight: 500, color: "var(--text-primary)" }}>Editar carrosséis</Link>
                      </div>
                    ) : "—"}</td>
                    <td>{u.papel !== "closer" ? <span className="ag-hint" style={{ fontSize: 14 }}>Não precisa</span>
                      : u.agenda === "conectada" ? "Conectada"
                      : <div className="rn-stack" style={{ gap: 2, alignItems: "flex-start" }}>
                          <span className="ag-pill" style={{ marginRight: 0 }}>{u.agenda === "desconectada" ? "Desconectada" : "Não conectada"}</span>
                          <span className="ag-hint">O closer conecta em Minha agenda, no painel.</span>
                        </div>}</td>
                    <td>{u.tem_login ? "Sim" : <span className="ag-hint" style={{ fontSize: 14 }}>Sem login</span>}</td>
                    <td><ActiveSwitch sdrId={u.sdr_id} profileId={u.profile_id} active={u.active} name={u.name} locked={(self || u.papel === "admin") && u.active} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="rn-footer">{rows.length} {rows.length === 1 ? "usuário" : "usuários"} · {rows.filter((u) => u.active).length} ativos. Desativar tira o acesso na hora; nenhum dado é apagado.</div>
      </div>
    </main>
  );
}
