import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { loadMeeting } from "@/lib/reuniao-google";
import { dateToLocal, formatDateTime, formatTime, localDay } from "@/lib/time";
import { EditarLivreForm } from "./EditarLivreForm";
import { HorarioForm } from "./HorarioForm";
import { MesmoDiaForm } from "./MesmoDiaForm";

export const metadata = { title: "Reagendar — Painel SDR" };

// SDR: Editar (mesmo dia) e Reagendar (outro dia) usam o mesmo fluxo: o mesmo evento e o mesmo link do Meet.
// Gestor e admin: edição livre (2026-10-13), sem trava de horário e com o closer que escolherem.
export default async function HorarioPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = (await createClient()).schema("painel");
  const [{ data: perm }, { data }] = await Promise.all([db.rpc("permissao_reuniao", { p_id: id }), db.rpc("reuniao_detalhe", { p_id: id })]);
  const m = (data ?? [])[0] as { title: string; starts_at: string; ends_at: string; status: string; closer: string | null } | undefined;
  if (!m || (perm !== "sdr" && perm !== "gestor")) notFound();
  const duration = Math.round((Date.parse(m.ends_at) - Date.parse(m.starts_at)) / 60_000);
  const livre = perm === "gestor";
  const closerId = livre ? (await loadMeeting(id))?.closer_id : undefined;
  // reunião agendada de hoje: a SDR também pode mudar o horário de hoje com o mesmo closer (2026-10-30)
  const hoje = localDay(new Date());
  const mesmoDia = !livre && m.status === "agendada" && localDay(new Date(m.starts_at)) === hoje;
  return (
    <main className="page">
      <div className="page-head"><h1 className="title">{livre ? "Editar reunião" : "Reagendar"}</h1></div>
      <p style={{ margin: 0 }}><strong>{m.title}</strong> · hoje marcada para {formatDateTime(m.starts_at)}–{formatTime(new Date(m.ends_at))}</p>
      {livre && closerId ? (
        <>
          <p className="muted" style={{ margin: 0 }}>
            Como gestor, você escolhe qualquer data, hora, duração e closer, mesmo ocupado. O painel só avisa. O convite é o mesmo (mesmo link do Meet) e os convidados recebem o novo horário.
          </p>
          <EditarLivreForm id={id} initialLocal={dateToLocal(new Date(m.starts_at))} initialDuration={duration} closerId={closerId} />
        </>
      ) : (
        <>
          <p className="muted" style={{ margin: 0 }}>
            O convite é o mesmo (mesmo link do Meet). O sistema tenta manter o mesmo closer; se ele não estiver livre no novo horário, o carrossel escolhe outro.
          </p>
          <HorarioForm id={id} initialDuration={duration} />
          {mesmoDia && <MesmoDiaForm id={id} day={hoje} initialDuration={duration} closerName={m.closer ?? "closer atual"} />}
        </>
      )}
    </main>
  );
}
