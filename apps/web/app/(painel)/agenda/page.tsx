import { redirect } from "next/navigation";
import { createClient, getMe } from "@/lib/supabase/server";
import { formatDateTime } from "@/lib/time";

export const metadata = { title: "Minha agenda — Painel SDR" };

// Tela do closer: situação da conexão da agenda do Google e o botão para conectar.
export default async function AgendaPage({ searchParams }: { searchParams: Promise<{ conectada?: string; erro?: string }> }) {
  const me = await getMe();
  if (me?.role !== "closer") redirect("/");
  const sp = await searchParams;
  const { data, error } = await (await createClient()).schema("painel").rpc("minha_agenda_google");
  if (error) throw new Error(`Não foi possível ler a sua agenda: ${error.message}`);
  const g = (data ?? [])[0] as { google_email: string; status: string; connected_at: string; last_error: string | null } | undefined;
  const ok = g?.status === "conectada";

  return (
    <main className="page">
      <div className="page-head"><h1 className="title">Minha agenda</h1></div>
      {sp.conectada && <div className="ok" role="status">Agenda conectada.</div>}
      {sp.erro && <div className="alert" role="alert">{sp.erro}</div>}
      <section className="card" style={{ gap: 12, maxWidth: 640 }}>
        <h2 className="card-title">Google Agenda</h2>
        {ok ? (
          <p style={{ margin: 0 }}>Conectada com <strong>{g!.google_email}</strong> desde {formatDateTime(g!.connected_at)}. Você já pode receber reuniões.</p>
        ) : g ? (
          <p style={{ margin: 0 }}><strong>Desconectada.</strong> Enquanto estiver assim, você não recebe reuniões. Clique em Conectar de novo.</p>
        ) : (
          <p style={{ margin: 0 }}>Sua agenda ainda não está conectada. Enquanto não estiver, você não recebe reuniões.</p>
        )}
        <p className="muted" style={{ margin: 0 }}>
          O painel só vê os seus horários livres e ocupados (nunca o conteúdo dos seus compromissos) e cria ou altera os eventos das reuniões que ele agendou.
        </p>
        <div className="group">
          <a className={`btn${ok ? "" : " primary"}`} href="/api/google/connect">{ok ? "Conectar de novo" : "Conectar minha agenda do Google"}</a>
        </div>
      </section>
    </main>
  );
}
