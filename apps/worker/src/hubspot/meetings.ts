// Reunião criada pelo painel no HubSpot (Fase 10e.1). Desde 2026-10-27 o painel não cria mais Reunião no HubSpot:
// quem cria é a integração do Google Calendar (ver reunioesAgenda.ts). Aqui só se atualizam horário/closer das
// Reuniões que o painel criou antes disso. Erros ficam em meetings.hubspot_error, sem dado de lead.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MeetingStatus } from "@painel/shared";
import type { HubspotClient } from "./leads.js";

export const OUTCOME: Record<MeetingStatus, string> = {
  agendada: "SCHEDULED", validada: "COMPLETED", noshow: "NO_SHOW", cancelada: "CANCELED", invalidada: "INVALIDADO",
};
const ASSOC_CONTACT = 200; // meeting → contact (HUBSPOT_DEFINED)
const ASSOC_LEAD = 601;    // meeting → lead (HUBSPOT_DEFINED)

export interface MeetingForHubspot {
  id: string; status: MeetingStatus; title: string | null; starts_at: string; ends_at: string; meet_url: string | null;
  hubspot_meeting_id: string | null; hubspot_contact_id: string | null; hubspot_lead_id: string | null;
  hubspot_status_synced?: string | null; google_event_id?: string | null; hubspot_agenda_meeting_id?: string | null;
  hubspot_outcome?: string | null; created_at?: string; closer_id?: string; google_calendar_id?: string | null; google_liberada?: boolean;
  hubspot_status_pendente?: boolean; status_changed_at?: string | null;
  closer_owner_id: string | null; sdr_owner_id: string | null;
}

/** Propriedades da Reunião no HubSpot. O status só entra quando pedido. */
export function meetingProps(m: MeetingForHubspot, withOutcome: boolean): Record<string, string> {
  const p: Record<string, string> = {
    hs_timestamp: new Date(m.starts_at).toISOString(),
    hs_meeting_title: m.title ?? "Reunião",
    hs_meeting_start_time: new Date(m.starts_at).toISOString(),
    hs_meeting_end_time: new Date(m.ends_at).toISOString(),
  };
  if (m.meet_url) p.hs_meeting_location = m.meet_url;
  if (m.closer_owner_id) p.hubspot_owner_id = m.closer_owner_id;
  if (m.sdr_owner_id) p.atividade_criada_por = m.sdr_owner_id;
  if (withOutcome) p.hs_meeting_outcome = OUTCOME[m.status];
  return p;
}

export function associations(m: MeetingForHubspot) {
  const a: { to: { id: string }; types: { associationCategory: "HUBSPOT_DEFINED"; associationTypeId: number }[] }[] = [];
  if (m.hubspot_contact_id) a.push({ to: { id: m.hubspot_contact_id }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: ASSOC_CONTACT }] });
  if (m.hubspot_lead_id) a.push({ to: { id: m.hubspot_lead_id }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: ASSOC_LEAD }] });
  return a;
}

export async function load(db: SupabaseClient, filter: (q: any) => any): Promise<MeetingForHubspot[]> {
  const p = db.schema("painel");
  const { data, error } = await filter(p.from("meetings")
    .select("id, status, title, starts_at, ends_at, meet_url, hubspot_meeting_id, hubspot_contact_id, hubspot_lead_id, hubspot_status_synced, google_event_id, hubspot_agenda_meeting_id, hubspot_outcome, created_at, closer_id, google_calendar_id, google_liberada, hubspot_status_pendente, status_changed_at, closer:sdrs!meetings_closer_id_fkey(poli_email), sdr:sdrs!meetings_sdr_id_fkey(poli_email)")
    .eq("source", "painel").not("google_event_id", "is", null));
  if (error) throw new Error(`ler reuniões para o HubSpot: ${error.message}`);
  const emails = [...new Set((data ?? []).flatMap((m: any) => [m.closer?.poli_email, m.sdr?.poli_email]).filter(Boolean))];
  const { data: owners } = emails.length ? await p.from("hubspot_owners").select("owner_id, email").in("email", emails) : { data: [] };
  const ownerOf = new Map((owners ?? []).map((o: { owner_id: string; email: string }) => [o.email.toLowerCase(), o.owner_id]));
  return (data ?? []).map((m: any) => ({
    ...m, closer_owner_id: ownerOf.get(String(m.closer?.poli_email ?? "").toLowerCase()) ?? null,
    sdr_owner_id: ownerOf.get(String(m.sdr?.poli_email ?? "").toLowerCase()) ?? null,
  }));
}

const is404 = (e: unknown) => /HTTP 404/.test(String((e as Error)?.message));

/** Atualiza horário/closer das Reuniões que o painel criou no HubSpot antes de 2026-10-27. Não cria nenhuma. */
export async function syncMeetings(db: SupabaseClient, hs: HubspotClient): Promise<{ atualizadas: number; erros: number }> {
  const p = db.schema("painel");
  const out = { atualizadas: 0, erros: 0 };
  const rows = await load(db, (q) => q.not("hubspot_meeting_id", "is", null).eq("hubspot_sync_needed", true).limit(50));
  for (const m of rows) {
    try {
      await hs.call(`/crm/v3/objects/meetings/${m.hubspot_meeting_id}`, { properties: meetingProps(m, false) }, "PATCH");
      await p.from("meetings").update({ hubspot_sync_needed: false, hubspot_synced_at: new Date().toISOString(), hubspot_error: null }).eq("id", m.id);
      out.atualizadas++;
    } catch (e) {
      out.erros++;
      // apagada no HubSpot: não recria (a Reunião oficial é a do Calendar)
      await p.from("meetings").update(is404(e) ? { hubspot_meeting_id: null, hubspot_sync_needed: false, hubspot_error: null }
        : { hubspot_error: String((e as Error).message).slice(0, 200) }).eq("id", m.id);
    }
  }
  return out;
}
