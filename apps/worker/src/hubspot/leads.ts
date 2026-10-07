// Sync dos Leads do HubSpot (objeto Lead) para painel.hubspot_leads. Só leitura no HubSpot.
// Busca os Leads modificados desde o cursor (painel.settings.hubspot_leads_cursor), em ordem de modificação,
// e grava etapa, pipeline, dono e o contato associado. Idempotente: upsert por id do Lead.
import type { SupabaseClient } from "@supabase/supabase-js";

const API = "https://api.hubapi.com";
const CURSOR_KEY = "hubspot_leads_cursor";
/** Primeira carga: Leads modificados desde o início dos dados do painel. */
export const INITIAL_SINCE = "2026-09-25T00:00:00-03:00";
const PAGE = 100;
const SEARCH_CAP = 10_000; // a busca do HubSpot não pagina além de 10 mil resultados por consulta

export interface HubspotLead {
  id: string;
  properties: Record<string, string | null>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class HubspotClient {
  constructor(private token: string) {}

  async call<T>(path: string, body?: unknown, method?: "POST" | "PATCH"): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(API + path, {
        method: method ?? (body ? "POST" : "GET"),
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.status === 429 && attempt < 5) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      if (!res.ok) throw new Error(`HubSpot ${path}: HTTP ${res.status}`);
      await sleep(250); // fica abaixo do limite da busca (5 req/s)
      return (await res.json()) as T;
    }
  }
}

/** Etapas cujas datas de entrada viram métricas ("Descartados" e "DSQ"), vindas de painel.settings. */
export interface MetricStages {
  descartado: string | null;
  dsq: string | null;
  agendado?: string[];   // etapas que contam como "agendou" (hubspot_agendado_stages)
}

/** Converte um Lead da API na linha de painel.hubspot_leads. */
export function toRow(lead: HubspotLead, contactId: string | null, stages: MetricStages = { descartado: null, dsq: null }) {
  const p = lead.properties;
  const entered = (stage: string | null) => (stage ? (p[`hs_v2_date_entered_${stage}`] ?? null) : null);
  const agendado = (stages.agendado ?? []).map((s) => entered(s)).filter((d): d is string => !!d).sort()[0] ?? null;
  return {
    hubspot_lead_id: lead.id,
    hubspot_contact_id: contactId,
    pipeline_id: p.hs_pipeline ?? null,
    stage_id: p.hs_pipeline_stage ?? null,
    owner_id: p.hubspot_owner_id ?? null,
    created_at: p.hs_createdate ?? null,
    updated_at: p.hs_lastmodifieddate ?? null,
    entered_descartado_at: entered(stages.descartado),
    entered_dsq_at: entered(stages.dsq),
    entered_agendado_at: agendado,
    synced_at: new Date().toISOString(),
  };
}

function check<T>(res: { data: T | null; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data as T;
}

/** Atualiza os nomes das etapas de todos os pipelines de Lead. */
export async function syncStages(db: SupabaseClient, hs: HubspotClient): Promise<number> {
  type Pipeline = { id: string; label: string; stages: { id: string; label: string; displayOrder: number; metadata?: { state?: string } }[] };
  const { results } = await hs.call<{ results: Pipeline[] }>("/crm/v3/pipelines/leads");
  const rows = results.flatMap((pl) =>
    pl.stages.map((st) => ({
      stage_id: st.id, pipeline_id: pl.id, pipeline_label: pl.label, label: st.label,
      state: st.metadata?.state ?? null, display_order: st.displayOrder,
    })),
  );
  check(await db.schema("painel").from("hubspot_stages").upsert(rows), "gravar etapas do HubSpot");
  return rows.length;
}

/** Atualiza os donos do HubSpot (id → e-mail), para ligar o dono do Lead ao SDR. */
export async function syncOwners(db: SupabaseClient, hs: HubspotClient): Promise<number> {
  type Owner = { id: string; email?: string; firstName?: string; lastName?: string };
  const rows: Record<string, string | null>[] = [];
  let after: string | undefined;
  do {
    const page = await hs.call<{ results: Owner[]; paging?: { next?: { after: string } } }>(`/crm/v3/owners?limit=100${after ? `&after=${after}` : ""}`);
    for (const o of page.results) {
      rows.push({ owner_id: String(o.id), email: o.email?.toLowerCase() ?? null, name: [o.firstName, o.lastName].filter(Boolean).join(" ") || null, synced_at: new Date().toISOString() });
    }
    after = page.paging?.next?.after;
  } while (after);
  check(await db.schema("painel").from("hubspot_owners").upsert(rows), "gravar donos do HubSpot");
  return rows.length;
}

async function metricStages(db: SupabaseClient): Promise<MetricStages> {
  const rows = check(await db.schema("painel").from("settings").select("key, value").in("key", ["hubspot_stage_descartado", "hubspot_stage_dsq", "hubspot_agendado_stages"]), "ler etapas das métricas");
  const find = (k: string) => rows.find((x: { key: string }) => x.key === k)?.value;
  const get = (k: string) => { const v = find(k); return v == null ? null : String(v); };
  const ag = find("hubspot_agendado_stages");
  return { descartado: get("hubspot_stage_descartado"), dsq: get("hubspot_stage_dsq"), agendado: Array.isArray(ag) ? ag.map(String) : [] };
}

/** Volta o cursor do sync de Leads para uma data (para reler, ex.: depois de passar a guardar um campo novo). */
export async function resetLeadsCursor(db: SupabaseClient, since: string): Promise<void> {
  const iso = new Date(`${since}T00:00:00-03:00`).toISOString();
  check(await db.schema("painel").from("settings").upsert({ key: CURSOR_KEY, value: iso, updated_at: new Date().toISOString() }), "voltar cursor do HubSpot");
}

/** Busca e grava os Leads modificados desde o cursor. Devolve quantos foram gravados. */
export async function syncLeads(db: SupabaseClient, hs: HubspotClient): Promise<number> {
  const p = db.schema("painel");
  const stages = await metricStages(db);
  const extra = [stages.descartado, stages.dsq, ...(stages.agendado ?? [])].filter(Boolean).map((id) => `hs_v2_date_entered_${id}`);
  const cur = check(await p.from("settings").select("value").eq("key", CURSOR_KEY), "ler cursor do HubSpot");
  let since = Date.parse(cur.length ? String(cur[0].value) : INITIAL_SINCE);
  let total = 0;

  for (;;) {
    let after: string | undefined;
    let lastModified = since;
    let fetched = 0;
    do {
      const page = await hs.call<{ results: HubspotLead[]; paging?: { next?: { after: string } } }>(
        "/crm/v3/objects/leads/search",
        {
          filterGroups: [{ filters: [{ propertyName: "hs_lastmodifieddate", operator: "GTE", value: String(since) }] }],
          sorts: [{ propertyName: "hs_lastmodifieddate", direction: "ASCENDING" }],
          properties: ["hs_pipeline", "hs_pipeline_stage", "hubspot_owner_id", "hs_createdate", "hs_lastmodifieddate", ...extra],
          limit: PAGE,
          after,
        },
      );
      if (!page.results.length) break;

      const assoc = await hs.call<{ results: { from: { id: string }; to: { toObjectId: number }[] }[] }>(
        "/crm/v4/associations/leads/contacts/batch/read",
        { inputs: page.results.map((l) => ({ id: l.id })) },
      );
      const contactOf = new Map(assoc.results.map((a) => [a.from.id, a.to[0] ? String(a.to[0].toObjectId) : null]));
      check(await p.from("hubspot_leads").upsert(page.results.map((l) => toRow(l, contactOf.get(l.id) ?? null, stages))), "gravar Leads do HubSpot");

      total += page.results.length;
      fetched += page.results.length;
      lastModified = Date.parse(page.results[page.results.length - 1].properties.hs_lastmodifieddate ?? "") || lastModified;
      after = page.paging?.next?.after;
    } while (after && fetched + PAGE <= SEARCH_CAP);

    // Guarda o cursor a cada consulta. Se bateu o limite de 10 mil, recomeça a partir do último modificado.
    check(await p.from("settings").upsert({ key: CURSOR_KEY, value: new Date(lastModified).toISOString(), updated_at: new Date().toISOString() }), "gravar cursor do HubSpot");
    if (!after) return total;
    since = lastModified;
  }
}
