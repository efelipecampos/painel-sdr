import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { formatDateTime, formatTime } from "@/lib/time";

export const metadata = { title: "Reunião agendada — Painel SDR" };

// Só depois de confirmar o SDR vê quem é o closer (regra do closer às cegas).
export default async function SucessoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { data } = await (await createClient()).schema("painel").rpc("reuniao_detalhe", { p_id: id });
  const m = (data ?? [])[0] as { starts_at: string; ends_at: string; title: string; closer: string; carousel: string; lead_email: string | null; fora_do_padrao: boolean } | undefined;
  if (!m) notFound();
  return (
    <main className="page">
      <section className="card" style={{ gap: 10, maxWidth: 640 }}>
        <h1 className="title">Reunião agendada</h1>
        <p style={{ margin: 0 }}><strong>{m.title}</strong></p>
        <p style={{ margin: 0 }}>{formatDateTime(m.starts_at)} às {formatTime(new Date(m.ends_at))} · closer <strong>{m.closer}</strong> · {m.carousel}</p>
        {m.fora_do_padrao && <p className="muted" style={{ margin: 0 }}>Marcada fora do horário padrão.</p>}
        <p className="muted" style={{ margin: 0 }}>
          O convite está na agenda do closer{m.lead_email ? " e foi enviado ao lead por e-mail" : " (o lead não tem e-mail: mande o link do Meet pelo chat)"}.
          Copie o link do Meet no seu Google Agenda.
        </p>
        <div className="group">
          <Link className="btn" href={`/reuniao/${id}`}>Ver passagem de bastão</Link>
          <Link className="btn primary" href="/agendar">Agendar outra</Link>
        </div>
      </section>
    </main>
  );
}
