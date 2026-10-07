import { redirect } from "next/navigation";
import { createClient, getMe } from "@/lib/supabase/server";
import { setUserActive } from "./actions";

export const metadata = { title: "Usuários — Painel SDR" };

interface Usuario {
  sdr_id: string | null; profile_id: string | null; name: string; email: string | null;
  papel: string; is_bot: boolean; tem_login: boolean; active: boolean;
}

const PAPEL: Record<string, string> = { admin: "Admin", gestor: "Gestor", sdr: "SDR", closer: "Closer" };

export default async function UsuariosPage({ searchParams }: { searchParams: Promise<{ salvo?: string; erro?: string }> }) {
  const me = await getMe();
  if (!me?.canManageUsers) redirect("/");
  const sp = await searchParams;
  const { data, error } = await (await createClient()).schema("painel").rpc("usuarios");
  if (error) throw new Error(`Não foi possível ler os usuários: ${error.message}`);
  // Só a equipe: SDRs, closers, gestores e admin. Robôs e outros atendentes da Poli ficam de fora.
  const rows = ((data ?? []) as Usuario[]).filter((u) => !u.is_bot && u.papel in PAPEL);

  return (
    <main className="page">
      <div className="page-head">
        <h1 className="title">Usuários</h1>
      </div>
      {sp.salvo && <div className="ok" role="status">{sp.salvo === "on" ? "Usuário reativado." : "Usuário desativado."}</div>}
      {sp.erro && <div className="alert" role="alert">{sp.erro}</div>}
      <p className="muted" style={{ margin: 0 }}>
        Desativar tira o acesso ao painel na hora e tira a pessoa dos cards, das listas e dos carrosséis. Nenhum dado é apagado: chats,
        reuniões e números de períodos passados continuam. Reativar desfaz.
      </p>
      <div className="card">
        <div className="table-wrap">
          <table>
            <thead><tr>
              <th scope="col">Nome</th><th scope="col">E-mail</th><th scope="col">Papel</th>
              <th scope="col">Login no painel</th><th scope="col">Situação</th><th scope="col"><span className="sr-only">Ação</span></th>
            </tr></thead>
            <tbody>
              {rows.map((u) => {
                const self = u.profile_id === me.id;
                const admin = u.papel === "admin";
                return (
                  <tr key={`${u.sdr_id}-${u.profile_id}`} style={{ opacity: u.active ? 1 : 0.55 }}>
                    <td>{u.name}</td>
                    <td>{u.email ?? "—"}</td>
                    <td>{PAPEL[u.papel]}</td>
                    <td>{u.tem_login ? "Sim" : "Não"}</td>
                    <td>{u.active ? "Ativo" : "Desativado"}</td>
                    <td>
                      {!(self || admin) || !u.active ? (
                        <form action={setUserActive}>
                          <input type="hidden" name="sdr_id" value={u.sdr_id ?? ""} />
                          <input type="hidden" name="profile_id" value={u.profile_id ?? ""} />
                          <input type="hidden" name="active" value={u.active ? "false" : "true"} />
                          <button className="btn small" type="submit">{u.active ? "Desativar" : "Reativar"}</button>
                        </form>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
