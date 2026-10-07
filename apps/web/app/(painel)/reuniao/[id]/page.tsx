import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { formatDateTime, formatTime } from "@/lib/time";

export const metadata = { title: "Passagem de bastão — Painel SDR" };

const STATUS: Record<string, string> = { agendada: "Agendada", validada: "Validada", noshow: "No show", invalidada: "Invalidada", cancelada: "Cancelada" };

// Link da descrição do evento. O banco só devolve a reunião ao closer dela, ao SDR que agendou e a gestor/admin.
export default async function ReuniaoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const { data, error } = await (await createClient()).schema("painel").rpc("reuniao_detalhe", { p_id: id });
  const m = (data ?? [])[0] as {
    starts_at: string; ends_at: string; status: string; title: string; carousel: string; closer: string; sdr: string | null;
    lead_name: string | null; company: string | null; lead_email: string | null; hubspot_contact_id: string | null;
    handoff: string | null; meet_url: string | null; fora_do_padrao: boolean;
  } | undefined;
  if (error || !m) {
    return (
      <main className="page">
        <section className="card" style={{ maxWidth: 560 }}>
          <h1 className="title">Sem acesso a esta reunião</h1>
          <p style={{ margin: 0 }}>Só o closer da reunião, o SDR que agendou e os gestores abrem a passagem de bastão.</p>
        </section>
      </main>
    );
  }
  return (
    <main className="page">
      <section className="card" style={{ gap: 10, maxWidth: 760 }}>
        <h1 className="title">{m.title}</h1>
        <p style={{ margin: 0 }}>
          {formatDateTime(m.starts_at)} às {formatTime(new Date(m.ends_at))} · {STATUS[m.status] ?? m.status} · {m.carousel}
          {m.fora_do_padrao ? " · fora do horário padrão" : ""}
        </p>
        <p style={{ margin: 0 }}>Closer: <strong>{m.closer}</strong> · SDR: <strong>{m.sdr ?? "—"}</strong></p>
        <p style={{ margin: 0 }}>
          Lead: <strong>{m.lead_name ?? "—"}</strong>{m.company ? ` · ${m.company}` : ""}{m.lead_email ? ` · ${m.lead_email}` : ""}
          {m.hubspot_contact_id && <> · <a href={`https://app.hubspot.com/contacts/50231385/record/0-1/${m.hubspot_contact_id}`} target="_blank" rel="noreferrer">abrir no HubSpot</a></>}
        </p>
        {m.meet_url && <p style={{ margin: 0 }}>Meet: <a href={m.meet_url} target="_blank" rel="noreferrer">{m.meet_url}</a></p>}
        <h2 className="card-title">Passagem de bastão</h2>
        <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{m.handoff || "O SDR não escreveu passagem de bastão."}</p>
      </section>
    </main>
  );
}
