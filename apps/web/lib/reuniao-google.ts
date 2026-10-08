// Evento do Google de uma reunião do painel, depois de agendada (Fase 10d.2): arquivo e mudança de horário.
// Cancelada e no show saem da agenda do closer (o horário fica livre) e vão para a agenda de arquivo, com o
// closer no título e a cor da situação. Voltar para agendada/validada traz o evento de volta, mesmo link do Meet.
import { ARCHIVE_COLOR, archiveTitle } from "@painel/shared/google";
import { APP_URL, calendarOf, withLog } from "@/lib/google";
import { createAdminClient } from "@/lib/supabase/admin";

const admin = () => createAdminClient().schema("painel");
const ARQUIVADAS = new Set(["cancelada", "noshow"]);

export interface MeetingRow {
  id: string; status: string; closer_id: string; title: string | null; lead_email: string | null; sdr_id: string | null;
  google_event_id: string | null; google_calendar_id: string | null; starts_at: string; ends_at: string;
}

export async function loadMeeting(id: string): Promise<MeetingRow | null> {
  const { data } = await admin().from("meetings")
    .select("id, status, closer_id, title, lead_email, sdr_id, google_event_id, google_calendar_id, starts_at, ends_at")
    .eq("id", id).eq("source", "painel").maybeSingle();
  return data as MeetingRow | null;
}

async function archiveId(): Promise<string> {
  const { data } = await admin().from("settings").select("value").eq("key", "google_archive_calendar_id").maybeSingle();
  const v = String(data?.value ?? "").trim();
  if (!v) throw new Error("A agenda de arquivo não está cadastrada em Configurações.");
  return v;
}

async function closerCalendarId(closerId: string): Promise<string> {
  const { data } = await admin().from("google_connections").select("google_email").eq("closer_id", closerId).single();
  return data!.google_email as string;
}

/** Põe o evento onde o status manda (arquivo ou agenda do closer) e com o título e a cor certos. */
export async function syncEventWithStatus(m: MeetingRow): Promise<void> {
  if (!m.google_event_id) return;
  const arq = await archiveId();
  const inArchive = m.google_calendar_id === arq;
  const shouldArchive = ARQUIVADAS.has(m.status);
  const cal = await calendarOf(m.closer_id);
  const title = m.title ?? "";
  if (shouldArchive) {
    const { data: c } = await admin().from("sdrs").select("name").eq("id", m.closer_id).single();
    if (!inArchive) await withLog(m.closer_id, "mover", () => cal.move(m.google_event_id!, arq, m.google_calendar_id || "primary"), m.id);
    await withLog(m.closer_id, "alterar", () => cal.patch(m.google_event_id!, {
      title: archiveTitle(title, c?.name ?? ""), colorId: ARCHIVE_COLOR[m.status as keyof typeof ARCHIVE_COLOR],
    }, arq, false), m.id);
    await admin().from("meetings").update({ google_calendar_id: arq }).eq("id", m.id);
  } else if (inArchive) {
    const dest = await closerCalendarId(m.closer_id);
    await withLog(m.closer_id, "mover", () => cal.move(m.google_event_id!, dest, arq), m.id);
    await withLog(m.closer_id, "alterar", () => cal.patch(m.google_event_id!, { title, colorId: null }, dest, false), m.id);
    await admin().from("meetings").update({ google_calendar_id: dest, google_state: "ok" }).eq("id", m.id);
  }
}

/**
 * Depois de reagendar no banco: muda o horário do mesmo evento. Se o closer mudou, cria o evento na agenda do
 * novo closer com o MESMO link do Meet e apaga o antigo sem avisar os convidados (eles recebem o convite novo).
 */
export async function moveEvent(before: MeetingRow, after: MeetingRow): Promise<void> {
  if (!before.google_event_id) return;
  const start = new Date(after.starts_at);
  const end = new Date(after.ends_at);
  // reunião que estava no arquivo (cancelada/no show) volta antes para a agenda do closer antigo
  if (before.status !== after.status || before.google_calendar_id === (await archiveId().catch(() => ""))) {
    await syncEventWithStatus({ ...before, status: after.status });
    before = (await loadMeeting(before.id))!;
  }
  const oldCal = await calendarOf(before.closer_id);
  const where = before.google_calendar_id || "primary";
  if (before.closer_id === after.closer_id) {
    await withLog(after.closer_id, "alterar", () => oldCal.patch(before.google_event_id!, { start, end }, where), after.id);
    return;
  }
  const old = await oldCal.get(before.google_event_id!, where);
  const newCal = await calendarOf(after.closer_id);
  const attendees = (old?.attendees ?? []).filter((a) => !a.self && !a.organizer).map((a) => a.email);
  const ev = await withLog(after.closer_id, "criar", () => newCal.insert({
    title: before.title ?? old?.summary ?? "Reunião",
    description: `Reunião agendada pelo Painel SDR.\n\nPassagem de bastão (equipe Poli, precisa de login): ${APP_URL}/reuniao/${after.id}`,
    start, end, attendees, conference: old?.conferenceData,
  }), after.id);
  await withLog(before.closer_id, "apagar", () => oldCal.remove(before.google_event_id!, where), after.id);
  await admin().from("meetings").update({
    google_event_id: ev.id, google_calendar_id: await closerCalendarId(after.closer_id), meet_url: ev.hangoutLink ?? null, google_state: "ok",
  }).eq("id", after.id);
}

/** Título novo (troca de marca): na agenda do closer o título puro; no arquivo, com o closer no final. */
export async function renameEvent(m: MeetingRow): Promise<void> {
  if (!m.google_event_id || !m.title) return;
  const cal = await calendarOf(m.closer_id);
  const arq = await archiveId().catch(() => "");
  let title = m.title;
  if (arq && m.google_calendar_id === arq) {
    const { data: c } = await admin().from("sdrs").select("name").eq("id", m.closer_id).single();
    title = archiveTitle(m.title, c?.name ?? "");
  }
  await withLog(m.closer_id, "alterar", () => cal.patch(m.google_event_id!, { title }, m.google_calendar_id || "primary", false), m.id);
}

/**
 * Evento apagado no Google ("Removida no Google"): tenta desfazer a exclusão (mesmo evento e mesmo Meet);
 * se o Google não tiver mais o evento, cria um novo na agenda do closer, convidando o lead e o SDR.
 */
export async function recreateEvent(m: MeetingRow, inviteSdr: boolean, sdrEmail: string | null): Promise<void> {
  const cal = await calendarOf(m.closer_id);
  const where = m.google_calendar_id || "primary";
  if (m.google_event_id) {
    try {
      const ev = await withLog(m.closer_id, "alterar", () => cal.patch(m.google_event_id!, { status: "confirmed" }, where), m.id);
      if (ev.status !== "cancelled") {
        await admin().from("meetings").update({ google_state: "ok", meet_url: ev.hangoutLink ?? null }).eq("id", m.id);
        return;
      }
    } catch {
      // segue para criar um novo
    }
  }
  const attendees = [m.lead_email, inviteSdr ? sdrEmail : null].filter((x): x is string => !!x);
  const ev = await withLog(m.closer_id, "criar", () => cal.insert({
    title: m.title ?? "Reunião", start: new Date(m.starts_at), end: new Date(m.ends_at), attendees,
    description: `Reunião agendada pelo Painel SDR.\n\nPassagem de bastão (equipe Poli, precisa de login): ${APP_URL}/reuniao/${m.id}`,
  }), m.id);
  await admin().from("meetings").update({
    google_event_id: ev.id, google_calendar_id: await closerCalendarId(m.closer_id), meet_url: ev.hangoutLink ?? null, google_state: "ok",
    hubspot_sync_needed: true,
  }).eq("id", m.id);
}
