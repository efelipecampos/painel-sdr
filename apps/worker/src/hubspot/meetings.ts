// Reunião no HubSpot (Fase 10e.1). Cria a Reunião ligada ao contato e ao Lead logo depois do agendamento,
// atualiza horário/closer quando mudam e, uma vez por dia (17:55), envia o status como hs_meeting_outcome.
// Não move o Lead de etapa (decisão de 2026-10-07). Erros ficam em meetings.hubspot_error, sem dado de lead.
import type { SupabaseClient } from "@supabase/supabase-js";
import { BUSINESS_TIMEZONE, type MeetingStatus } from "@painel/shared";
import type { HubspotClient } from "./leads.js";

export const OUTCOME: Record<MeetingStatus, string> = {
  agendada: "SCHEDULED", validada: "COMPLETED", noshow: "NO_SHOW", cancelada: "CANCELED", invalidada: "INVALIDADO",
};
const ASSOC_CONTACT = 200; // meeting → contact (HUBSPOT_DEFINED)
const ASSOC_LEAD = 601;    // meeting → lead (HUBSPOT_DEFINED)

export interface MeetingForHubspot {
  id: string; status: MeetingStatus; title: string | null; starts_at: string; ends_at: string; meet_url: string | null;
  hubspot_meeting_id: string | null; hubspot_contact_id: string | null; hubspot_lead_id: string | null;
  hubspot_status_synced?: string | null;
  closer_owner_id: string | null; sdr_owner_id: string | null;
}

/** Propriedades da Reunião no HubSpot. O status só entra quando pedido (criação e rodada das 17:55). */
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

/** A rodada diária deve rodar agora? (passou da hora no fuso de negócio e ainda não rodou hoje) */
export function dueDailyRun(now: Date, time: string, lastDay: string): { due: boolean; today: string } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(now);
  const g = (t: string) => parts.find((x) => x.type === t)!.value;
  const today = `${g("year")}-${g("month")}-${g("day")}`;
  return { due: `${g("hour")}:${g("minute")}` >= time && lastDay !== today, today };
}

async function load(db: SupabaseClient, filter: (q: any) => any): Promise<MeetingForHubspot[]> {
  const p = db.schema("painel");
  const { data, error } = await filter(p.from("meetings")
    .select("id, status, title, starts_at, ends_at, meet_url, hubspot_meeting_id, hubspot_contact_id, hubspot_lead_id, hubspot_status_synced, closer:sdrs!meetings_closer_id_fkey(poli_email), sdr:sdrs!meetings_sdr_id_fkey(poli_email)")
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

/** Cria as Reuniões que faltam e atualiza as marcadas (horário/closer mudou). */
export async function syncMeetings(db: SupabaseClient, hs: HubspotClient): Promise<{ criadas: number; atualizadas: number; erros: number }> {
  const p = db.schema("painel");
  const out = { criadas: 0, atualizadas: 0, erros: 0 };
  const rows = await load(db, (q) => q.or("hubspot_meeting_id.is.null,hubspot_sync_needed.eq.true").limit(50));
  for (const m of rows) {
    try {
      if (!m.hubspot_meeting_id) {
        const r = await hs.call<{ id: string }>("/crm/v3/objects/meetings", { properties: meetingProps(m, true), associations: associations(m) });
        await p.from("meetings").update({
          hubspot_meeting_id: r.id, hubspot_sync_needed: false, hubspot_synced_at: new Date().toISOString(),
          hubspot_status_synced: m.status, hubspot_error: null,
        }).eq("id", m.id);
        out.criadas++;
      } else {
        await hs.call(`/crm/v3/objects/meetings/${m.hubspot_meeting_id}`, { properties: meetingProps(m, false) }, "PATCH");
        await p.from("meetings").update({ hubspot_sync_needed: false, hubspot_synced_at: new Date().toISOString(), hubspot_error: null }).eq("id", m.id);
        out.atualizadas++;
      }
    } catch (e) {
      out.erros++;
      await p.from("meetings").update({ hubspot_error: String((e as Error).message).slice(0, 200) }).eq("id", m.id);
    }
  }
  return out;
}

/** Rodada das 17:55: envia o status (e título/horário) de toda reunião cujo status mudou desde o último envio. */
export async function dailyStatusRun(db: SupabaseClient, hs: HubspotClient, now = new Date()): Promise<number | null> {
  const p = db.schema("painel");
  const { data: st } = await p.from("settings").select("key, value").in("key", ["hubspot_status_sync_time", "hubspot_status_sync_day"]);
  const v = new Map((st ?? []).map((r: { key: string; value: unknown }) => [r.key, String(r.value ?? "")]));
  const { due, today } = dueDailyRun(now, v.get("hubspot_status_sync_time") || "17:55", v.get("hubspot_status_sync_day") ?? "");
  if (!due) return null;
  const rows = await load(db, (q) => q.not("hubspot_meeting_id", "is", null));
  let n = 0;
  for (const m of rows.filter((r) => r.hubspot_status_synced !== r.status)) {
    try {
      await hs.call(`/crm/v3/objects/meetings/${m.hubspot_meeting_id}`, { properties: meetingProps(m, true) }, "PATCH");
      await p.from("meetings").update({ hubspot_status_synced: m.status, hubspot_synced_at: new Date().toISOString(), hubspot_error: null }).eq("id", m.id);
      n++;
    } catch (e) {
      await p.from("meetings").update({ hubspot_error: String((e as Error).message).slice(0, 200) }).eq("id", m.id);
    }
  }
  await p.from("settings").upsert({ key: "hubspot_status_sync_day", value: today, updated_at: new Date().toISOString() });
  return n;
}
