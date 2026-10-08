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

const is404 = (e: unknown) => /HTTP 404/.test(String((e as Error)?.message));

/** Cria as Reuniões que faltam e atualiza as marcadas (horário/closer mudou). Apagada no HubSpot: recria. */
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
      if (m.hubspot_meeting_id && is404(e)) {
        // alguém apagou a Reunião no HubSpot: cria de novo na próxima rodada
        await p.from("meetings").update({ hubspot_meeting_id: null, hubspot_sync_needed: true, hubspot_error: "apagada no HubSpot; recriando" }).eq("id", m.id);
      } else {
        await p.from("meetings").update({ hubspot_error: String((e as Error).message).slice(0, 200) }).eq("id", m.id);
      }
    }
  }
  return out;
}

/** Reuniões que não chegam ao HubSpot há mais de N minutos (para o alerta). Primeira falha vista em memória. */
const failingSince = new Map<string, number>();
const alerted = new Set<string>();
export async function stuckMeetings(db: SupabaseClient, minutes = 15, now = Date.now()): Promise<{ id: string; title: string | null; error: string | null }[]> {
  const { data } = await db.schema("painel").from("meetings").select("id, title, hubspot_error")
    .eq("source", "painel").not("google_event_id", "is", null).not("hubspot_error", "is", null);
  const failing = new Set((data ?? []).map((m: { id: string }) => m.id));
  for (const id of [...failingSince.keys()]) if (!failing.has(id)) { failingSince.delete(id); alerted.delete(id); }
  const out = [];
  for (const m of (data ?? []) as { id: string; title: string | null; hubspot_error: string | null }[]) {
    if (!failingSince.has(m.id)) failingSince.set(m.id, now);
    if (now - failingSince.get(m.id)! >= minutes * 60_000 && !alerted.has(m.id)) {
      alerted.add(m.id);
      out.push({ id: m.id, title: m.title, error: m.hubspot_error });
    }
  }
  return out;
}

const READ_PROPS = ["hs_timestamp", "hs_meeting_title", "hs_meeting_start_time", "hs_meeting_end_time", "hs_meeting_outcome", "hs_meeting_location", "hubspot_owner_id", "atividade_criada_por"];

/** Campos diferentes entre o que o painel espera e o que está no HubSpot (datas comparadas pelo instante). */
export function diffMeeting(expected: Record<string, string>, actual: Record<string, string | null | undefined>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(expected)) {
    const a = actual[k];
    const same = /_time$|^hs_timestamp$/.test(k) ? !!a && Date.parse(a) === Date.parse(v) : (a ?? "") === v;
    if (!same) out.push(k);
  }
  return out;
}

export interface DailyResult { conferidas: number; corrigidas: number; recriadas: number; duplicadas: string[] }

/**
 * Rodada das 17:55 (decisões de 2026-10-07): para toda reunião dos últimos 5 dias (e as futuras), e para as
 * mais antigas cujo status mudou, relê a Reunião no HubSpot, corrige o que estiver diferente (inclusive o
 * resultado), recria a apagada e aponta possível duplicada (outra Reunião do mesmo contato no mesmo dia).
 */
export async function dailyCheck(db: SupabaseClient, hs: HubspotClient, now = new Date(), days = 5): Promise<DailyResult | null> {
  const p = db.schema("painel");
  const { data: st } = await p.from("settings").select("key, value").in("key", ["hubspot_status_sync_time", "hubspot_status_sync_day"]);
  const v = new Map((st ?? []).map((r: { key: string; value: unknown }) => [r.key, String(r.value ?? "")]));
  const { due, today } = dueDailyRun(now, v.get("hubspot_status_sync_time") || "17:55", v.get("hubspot_status_sync_day") ?? "");
  if (!due) return null;
  const since = new Date(now.getTime() - days * 86400_000).toISOString();
  const rows = (await load(db, (q) => q.not("hubspot_meeting_id", "is", null)))
    .filter((m) => m.starts_at >= since || m.hubspot_status_synced !== m.status);
  const ours = new Set(rows.map((m) => m.hubspot_meeting_id));
  const out: DailyResult = { conferidas: 0, corrigidas: 0, recriadas: 0, duplicadas: [] };
  const dayOf = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: BUSINESS_TIMEZONE });
  for (const m of rows) {
    try {
      let cur: { properties: Record<string, string | null>; associations?: Record<string, { results: { id: string }[] }> };
      try {
        cur = await hs.call(`/crm/v3/objects/meetings/${m.hubspot_meeting_id}?properties=${READ_PROPS.join(",")}&associations=contacts,leads`);
      } catch (e) {
        if (!is404(e)) throw e;
        await p.from("meetings").update({ hubspot_meeting_id: null, hubspot_sync_needed: true, hubspot_error: "apagada no HubSpot; recriando" }).eq("id", m.id);
        out.recriadas++;
        continue;
      }
      out.conferidas++;
      const expected = meetingProps(m, true);
      const diff = diffMeeting(expected, cur.properties);
      if (diff.length) {
        await hs.call(`/crm/v3/objects/meetings/${m.hubspot_meeting_id}`, { properties: expected }, "PATCH");
        out.corrigidas++;
      }
      const has = (t: string, id: string | null) => !id || (cur.associations?.[t]?.results ?? []).some((x) => String(x.id) === id);
      if (!has("contacts", m.hubspot_contact_id)) await hs.call(`/crm/v4/objects/meetings/${m.hubspot_meeting_id}/associations/default/contacts/${m.hubspot_contact_id}`, {}, "PUT");
      if (!has("leads", m.hubspot_lead_id)) await hs.call(`/crm/v4/objects/meetings/${m.hubspot_meeting_id}/associations/default/leads/${m.hubspot_lead_id}`, {}, "PUT");
      // possível duplicada: outra Reunião do mesmo contato no mesmo dia, criada fora do painel
      if (m.hubspot_contact_id) {
        const a = await hs.call<{ results: { toObjectId: number | string }[] }>(`/crm/v4/objects/contacts/${m.hubspot_contact_id}/associations/meetings`);
        const others = (a.results ?? []).map((x) => String(x.toObjectId)).filter((id) => !ours.has(id));
        if (others.length) {
          const r = await hs.call<{ results: { id: string; properties: Record<string, string | null> }[] }>(
            "/crm/v3/objects/meetings/batch/read", { inputs: others.map((id) => ({ id })), properties: ["hs_meeting_start_time"] });
          if ((r.results ?? []).some((o) => o.properties.hs_meeting_start_time && dayOf(o.properties.hs_meeting_start_time) === dayOf(m.starts_at))) {
            out.duplicadas.push(`${m.title ?? "Reunião"} (${dayOf(m.starts_at).split("-").reverse().join("/")})`);
          }
        }
      }
      await p.from("meetings").update({ hubspot_status_synced: m.status, hubspot_synced_at: new Date().toISOString(), hubspot_error: null }).eq("id", m.id);
    } catch (e) {
      await p.from("meetings").update({ hubspot_error: String((e as Error).message).slice(0, 200) }).eq("id", m.id);
    }
  }
  await p.from("settings").upsert({ key: "hubspot_status_sync_day", value: today, updated_at: new Date().toISOString() });
  return out;
}
