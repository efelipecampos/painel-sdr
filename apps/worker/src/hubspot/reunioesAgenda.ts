// Reunião oficial no HubSpot (decisão do Felipe, 2026-10-27). O painel cria só o evento no Google Calendar; a
// integração Calendar→HubSpot cria a Reunião no HubSpot com o id do evento em hs_unique_id. A cada 5 min o worker
// acha essa Reunião, liga ao Lead, preenche "Atividade criada pelo SDR" e lê dela o status (o HubSpot é a fonte).
// Reunião que está no Calendar e não chegou ao HubSpot: aviso no painel e no Gestão SDR (a cada 30 min).
// LGPD: logs e alertas sem nome, telefone ou e-mail de lead (o título da reunião leva só a empresa).
import type { SupabaseClient } from "@supabase/supabase-js";
import { BUSINESS_TIMEZONE, type MeetingStatus } from "@painel/shared";
import { GoogleError, type GoogleCalendar } from "@painel/shared/google";
import type { HubspotClient } from "./leads.js";
import { OUTCOME, load, type MeetingForHubspot } from "./meetings.js";
import { semHubspot } from "@painel/shared/hubspot";

export { semHubspot };

/** hs_meeting_outcome → status do painel (Rescheduled conta como agendada). */
export const STATUS_DO_OUTCOME: Record<string, MeetingStatus> = {
  SCHEDULED: "agendada", RESCHEDULED: "agendada", COMPLETED: "validada", NO_SHOW: "noshow", CANCELED: "cancelada", INVALIDADO: "invalidada",
};
const FINAIS = new Set(["COMPLETED", "NO_SHOW", "CANCELED", "INVALIDADO"]);
const ASSOC_LEAD = 601; // meeting → lead (HUBSPOT_DEFINED)
const JANELA_DIAS = 21;

/**
 * Status vindo do HubSpot: o da Reunião do Calendar quando preenchido; senão o da Reunião que o painel criou antes
 * de 2026-10-27, só se for um resultado final (o "Scheduled" dela foi o painel que gravou). Sem nada: não muda.
 */
export function statusDoHubspot(agenda: string | null | undefined, painel: string | null | undefined): { status: MeetingStatus; outcome: string } | null {
  if (agenda && STATUS_DO_OUTCOME[agenda]) return { status: STATUS_DO_OUTCOME[agenda], outcome: agenda };
  if (painel && FINAIS.has(painel)) return { status: STATUS_DO_OUTCOME[painel], outcome: painel };
  return null;
}

type Props = Record<string, string | null>;

/** Campos que o painel sempre impõe na Reunião do Calendar (decisão do Felipe, 2026-10-27): para os relatórios. */
export function camposPainel(m: Pick<MeetingForHubspot, "sdr_owner_id" | "closer_owner_id"> | undefined): Record<string, string> {
  return {
    hs_activity_type: "[Reunião] - Apresentação",
    sdr_quem_agendou_a_reuniao: "true",
    ...(m?.sdr_owner_id ? { atividade_criada_por: m.sdr_owner_id } : {}),
    ...(m?.closer_owner_id ? { hubspot_owner_id: m.closer_owner_id, closer_responsavel_pela_reuniao: m.closer_owner_id } : {}),
  };
}
export function camposDiferentes(quer: Record<string, string>, tem: Props): Record<string, string> {
  return Object.fromEntries(Object.entries(quer).filter(([k, v]) => tem[k] !== v));
}
async function batchRead(hs: Pick<HubspotClient, "call">, ids: string[], props: string[], idProperty?: string): Promise<Map<string, { id: string; properties: Props }>> {
  const out = new Map<string, { id: string; properties: Props }>();
  for (let i = 0; i < ids.length; i += 100) {
    const r = await hs.call<{ results?: { id: string; properties: Props }[] }>("/crm/v3/objects/meetings/batch/read", {
      inputs: ids.slice(i, i + 100).map((id) => ({ id })), properties: idProperty ? [...props, idProperty] : props, ...(idProperty ? { idProperty } : {}),
    });
    for (const m of r.results ?? []) out.set(idProperty ? String(m.properties[idProperty]) : m.id, m);
  }
  return out;
}

async function settingDesde(db: SupabaseClient): Promise<string> {
  const { data } = await db.schema("painel").from("settings").select("value").eq("key", "reunioes_status_hubspot_desde").maybeSingle();
  return typeof data?.value === "string" ? data.value : "9999-12-31T00:00:00Z";
}

export interface RodadaAgenda { ligadas: number; status: number; liberadas: number; erros: number }
export type CalendarDe = (closerId: string) => Promise<Pick<GoogleCalendar, "patch"> | null>;
const CINZA = "8";

/** Cancelada: evento Disponível e cinza na agenda do closer (libera o horário); voltou a valer: Ocupado e cor normal. */
async function liberarNoGoogle(db: SupabaseClient, calendarDe: CalendarDe, m: MeetingForHubspot, status: string): Promise<boolean> {
  const liberar = status === "cancelada";
  if (liberar === !!m.google_liberada || !m.closer_id || !m.google_event_id) return false;
  const cal = await calendarDe(m.closer_id);
  if (!cal) return false;
  const op = liberar ? "liberar" : "ocupar";
  const log = (ok: boolean, e?: GoogleError) => db.schema("painel").from("calendar_log").insert({
    closer_id: m.closer_id, meeting_id: m.id, op, ok, http_status: e?.status ?? null, reason: e?.reason ?? null,
  });
  try {
    // o cliente do Google já tenta de novo quando o Google pede para esperar (limite de pedidos)
    await cal.patch(m.google_event_id, liberar ? { transparency: "transparent", colorId: CINZA } : { transparency: "opaque", colorId: null },
      m.google_calendar_id || "primary", false);
    await log(true);
  } catch (e) {
    const ge = e instanceof GoogleError ? e : null;
    await log(false, ge ?? undefined);
    // só evento apagado (404/410) conta como "nada a liberar"; o resto (403 de permissão, limite) tenta na próxima rodada
    if (!(ge && (ge.status === 404 || ge.status === 410))) throw e;
  }
  await db.schema("painel").from("meetings").update({ google_liberada: liberar }).eq("id", m.id);
  return true;
}

/** `recentes`: só as agendadas na última hora ainda sem Reunião do Calendar (roda a cada rodada do worker). */
export async function sincronizarReunioesAgenda(db: SupabaseClient, hs: Pick<HubspotClient, "call">, calendarDe: CalendarDe, now = Date.now(), recentes = false): Promise<RodadaAgenda> {
  const p = db.schema("painel");
  const out: RodadaAgenda = { ligadas: 0, status: 0, liberadas: 0, erros: 0 };
  const desde = await settingDesde(db);
  const rows: MeetingForHubspot[] = await load(db, (q) => recentes
    ? q.is("hubspot_agenda_meeting_id", null).gte("created_at", new Date(now - 3600_000).toISOString())
    : q.gte("starts_at", new Date(now - JANELA_DIAS * 86400_000).toISOString()));
  if (!rows.length) return out;
  const agenda = await batchRead(hs, rows.map((m) => m.google_event_id!), ["hs_meeting_outcome", "hs_activity_type", "sdr_quem_agendou_a_reuniao", "atividade_criada_por", "hubspot_owner_id", "closer_responsavel_pela_reuniao"], "hs_unique_id");
  const doStatus = (m: MeetingForHubspot) => m.starts_at >= desde;
  const antigas = rows.filter((m) => doStatus(m) && m.hubspot_meeting_id && !agenda.get(m.google_event_id!)?.properties.hs_meeting_outcome);
  const painel = antigas.length ? await batchRead(hs, antigas.map((m) => m.hubspot_meeting_id!), ["hs_meeting_outcome"]) : new Map();

  for (const m of rows) {
    const copia = agenda.get(m.google_event_id!);
    try {
      if (copia && copia.id !== m.hubspot_agenda_meeting_id) {
        if (m.hubspot_lead_id) {
          await hs.call(`/crm/v4/objects/meetings/${copia.id}/associations/leads/${m.hubspot_lead_id}`,
            [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: ASSOC_LEAD }], "PUT");
        }
        await p.from("meetings").update({ hubspot_agenda_meeting_id: copia.id, hubspot_agenda_visto_at: new Date(now).toISOString() }).eq("id", m.id);
        out.ligadas++;
      }
      if (copia) {
        const diff = camposDiferentes(camposPainel(m), copia.properties);
        if (Object.keys(diff).length) await hs.call(`/crm/v3/objects/meetings/${copia.id}`, { properties: diff }, "PATCH");
      } else if (!copia && m.hubspot_agenda_meeting_id) {
        // o evento mudou (troca de closer cria outro) ou a Reunião sumiu do HubSpot: procura de novo
        await p.from("meetings").update({ hubspot_agenda_meeting_id: null }).eq("id", m.id);
      }
      if (!doStatus(m)) continue;
      if (m.hubspot_status_pendente) { // mudou no painel: enviarStatusPendentes decide quem vale
        if (await liberarNoGoogle(db, calendarDe, m, m.status)) out.liberadas++;
        continue;
      }
      const s = statusDoHubspot(copia?.properties.hs_meeting_outcome, m.hubspot_meeting_id ? painel.get(m.hubspot_meeting_id)?.properties.hs_meeting_outcome : null);
      if (s && (s.status !== m.status || s.outcome !== m.hubspot_outcome)) {
        const { data, error } = await p.rpc("aplicar_status_hubspot", { p_id: m.id, p_status: s.status, p_outcome: s.outcome });
        if (error) throw new Error(`aplicar_status_hubspot: ${error.message}`);
        if (data) out.status++;
      }
      if (await liberarNoGoogle(db, calendarDe, m, s?.status ?? m.status)) out.liberadas++;
    } catch (e) {
      out.erros++;
      console.error(`[worker] reunião ${m.id} no HubSpot:`, (e as Error).message);
    }
  }
  return out;
}

/**
 * Status marcado no painel → hs_meeting_outcome da Reunião oficial (a do Calendar; sem ela, a antiga do painel).
 * Vale a última mudança: se o HubSpot mudou depois (valor diferente do último conhecido e data posterior à
 * mudança no painel), o painel recebe o do HubSpot. Sem Reunião no HubSpot ainda: fica pendente.
 */
export function quemVale(m: { status_changed_at?: string | null; hubspot_outcome?: string | null }, noHubspot: string | null, mudouEm: string | null): "painel" | "hubspot" {
  if ((noHubspot ?? null) === (m.hubspot_outcome ?? null) || !mudouEm || !m.status_changed_at) return "painel";
  return Date.parse(mudouEm) > Date.parse(m.status_changed_at) ? "hubspot" : "painel";
}

export async function enviarStatusPendentes(db: SupabaseClient, hs: Pick<HubspotClient, "call">): Promise<{ enviadas: number; doHubspot: number; erros: number }> {
  const p = db.schema("painel");
  const out = { enviadas: 0, doHubspot: 0, erros: 0 };
  const { data, error } = await p.from("meetings")
    .select("id, status, status_changed_at, hubspot_outcome, hubspot_agenda_meeting_id, hubspot_meeting_id")
    .eq("hubspot_status_pendente", true).limit(50);
  if (error) throw new Error(`ler status pendentes: ${error.message}`);
  for (const m of data ?? []) {
    const alvo = m.hubspot_agenda_meeting_id ?? m.hubspot_meeting_id;
    if (!alvo) continue;
    try {
      const cur = await hs.call<{ properties: Props; propertiesWithHistory?: Record<string, { value: string; timestamp: string }[]> }>(
        `/crm/v3/objects/meetings/${alvo}?properties=hs_meeting_outcome&propertiesWithHistory=hs_meeting_outcome`);
      const atual = cur.properties.hs_meeting_outcome || null;
      const mudouEm = cur.propertiesWithHistory?.hs_meeting_outcome?.[0]?.timestamp ?? null;
      const s = quemVale(m, atual, mudouEm) === "hubspot" ? statusDoHubspot(atual, null) : null;
      if (s) {
        const { error: e2 } = await p.rpc("aplicar_status_hubspot", { p_id: m.id, p_status: s.status, p_outcome: s.outcome });
        if (e2) throw new Error(`aplicar_status_hubspot: ${e2.message}`);
        out.doHubspot++;
        continue;
      }
      const outcome = OUTCOME[m.status as MeetingStatus];
      await hs.call(`/crm/v3/objects/meetings/${alvo}`, { properties: { hs_meeting_outcome: outcome } }, "PATCH");
      await p.from("meetings").update({ hubspot_outcome: outcome, hubspot_status_pendente: false, hubspot_status_synced: m.status }).eq("id", m.id);
      out.enviadas++;
    } catch (e) {
      out.erros++;
      console.error(`[worker] status da reunião ${m.id} para o HubSpot:`, (e as Error).message);
    }
  }
  return out;
}

/** Texto do alerta das reuniões de hoje em diante que estão no Calendar e não no HubSpot (null: nenhuma). */
export async function alertaSemHubspot(db: SupabaseClient, now = Date.now()): Promise<string | null> {
  const hoje = new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_TIMEZONE }).format(new Date(now));
  const inicio = new Date(`${hoje}T03:00:00Z`).toISOString(); // 00:00 em São Paulo (sem horário de verão)
  const { data, error } = await db.schema("painel").from("meetings")
    .select("status, title, starts_at, created_at, google_event_id, hubspot_agenda_meeting_id, hubspot_meeting_id, closer:sdrs!meetings_closer_id_fkey(name), sdr:sdrs!meetings_sdr_id_fkey(name)")
    .eq("source", "painel").gte("starts_at", inicio).order("starts_at");
  if (error) throw new Error(`ler reuniões sem HubSpot: ${error.message}`);
  const nome = (x: unknown) => (Array.isArray(x) ? x[0]?.name : (x as { name?: string } | null)?.name) ?? "—";
  const lista = (data ?? []).filter((m) => semHubspot(m, now));
  if (!lista.length) return null;
  const quando = (d: string) => new Date(d).toLocaleString("pt-BR", { timeZone: BUSINESS_TIMEZONE, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  return `⚠️ *Reuniões no Calendar que não estão no HubSpot* (${lista.length})\n`
    + lista.map((m) => `• ${quando(m.starts_at)} · closer ${nome(m.closer)} · SDR ${nome(m.sdr)} · ${m.title ?? "sem título"}`).join("\n")
    + "\nProvável causa: a agenda do closer não está conectada ao HubSpot.";
}
