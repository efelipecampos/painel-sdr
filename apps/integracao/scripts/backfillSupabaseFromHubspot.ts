/**
 * Copia pro Supabase as mensagens que já estão no HubSpot (Communications da
 * Poli), pro painel nascer com histórico. Mensagens antigas de mídia ficaram
 * sem conteúdo no HubSpot, então vão vazias mesmo.
 *
 * Por padrão só simula. Pra gravar, passe --apply:
 *   npm run backfill:supabase -- --since 2026-09-18
 *   npm run backfill:supabase -- --since 2026-09-18 --apply
 */
import { isProspectingOpener } from "../src/config/prospectingTemplates.js";
import { isSupabaseConfigured } from "../src/supabase/client.js";
import { upsertMessages, type MessageRow } from "../src/supabase/messages.js";
import { chunk, hubspotFetch } from "./throttledHubspot.js";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const sinceArg = args[args.indexOf("--since") + 1];
if (!args.includes("--since") || !sinceArg) {
  console.error("Uso: --since AAAA-MM-DD [--apply]");
  process.exit(1);
}
if (!isSupabaseConfigured()) {
  console.error("Falta SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY no .env");
  process.exit(1);
}
const sinceMs = new Date(`${sinceArg}T00:00:00-03:00`).getTime();

interface SearchResponse {
  results: Array<{ id: string; properties: Record<string, string | null | undefined> }>;
  paging?: { next?: { after: string } };
}

interface BatchAssociationsResponse {
  results: Array<{ from: { id: string }; to: Array<{ toObjectId: number }> }>;
}

async function ownerEmailsById(): Promise<Map<string, { email?: string; name?: string }>> {
  const map = new Map<string, { email?: string; name?: string }>();
  let after: string | undefined;
  do {
    const res = await hubspotFetch<{
      results: Array<{ id: string; email?: string; firstName?: string; lastName?: string }>;
      paging?: { next?: { after: string } };
    }>(`/crm/v3/owners?limit=100${after ? `&after=${after}` : ""}`);
    for (const o of res.results) {
      map.set(o.id, { email: o.email, name: [o.firstName, o.lastName].filter(Boolean).join(" ") || undefined });
    }
    after = res.paging?.next?.after;
  } while (after);
  return map;
}

async function searchCommunications(): Promise<SearchResponse["results"]> {
  const out: SearchResponse["results"] = [];
  let after: string | undefined;
  do {
    const res = await hubspotFetch<SearchResponse>("/crm/v3/objects/communications/search", {
      method: "POST",
      body: JSON.stringify({
        filterGroups: [
          {
            filters: [
              { propertyName: "poli_direcao", operator: "HAS_PROPERTY" },
              { propertyName: "hs_timestamp", operator: "GTE", value: String(sinceMs) },
            ],
          },
        ],
        properties: [
          "hs_communication_body",
          "hs_timestamp",
          "poli_direcao",
          "poli_tipo_mensagem",
          "poli_nome_template",
          "hubspot_owner_id",
        ],
        sorts: [{ propertyName: "hs_timestamp", direction: "ASCENDING" }],
        limit: 200,
        after,
      }),
    });
    out.push(...res.results);
    after = res.paging?.next?.after;
  } while (after);
  return out;
}

async function batchAssociations(to: string, ids: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  for (const part of chunk(ids, 1000)) {
    const res = await hubspotFetch<BatchAssociationsResponse>(`/crm/v4/associations/communications/${to}/batch/read`, {
      method: "POST",
      body: JSON.stringify({ inputs: part.map((id) => ({ id })) }),
    });
    for (const r of res.results) map.set(r.from.id, r.to.map((t) => String(t.toObjectId)));
  }
  return map;
}

/** Remove o prefixo "[Recebida] " / "[Enviada] " que a integração escreve. */
function stripPrefix(body: string): string {
  return body.replace(/^\[(Recebida|Enviada)\]\s*/, "");
}

async function main() {
  console.log(`Buscando Communications da Poli desde ${sinceArg} (${apply ? "APLICANDO" : "simulação"})...`);
  const [communications, owners] = await Promise.all([searchCommunications(), ownerEmailsById()]);
  console.log(`${communications.length} mensagens no HubSpot, ${owners.size} owners.`);
  if (communications.length === 0) return;

  const ids = communications.map((c) => c.id);
  const toContacts = await batchAssociations("contacts", ids);
  const toDeals = await batchAssociations("deals", ids);

  const rows: MessageRow[] = communications.map((c) => {
    const p = c.properties;
    const owner = p.hubspot_owner_id ? owners.get(p.hubspot_owner_id) : undefined;
    const templateName = p.poli_nome_template ?? null;
    return {
      external_message_id: null,
      hubspot_communication_id: c.id,
      poli_message_uuid: null,
      direction: p.poli_direcao === "RECEBIDA" ? "IN" : "OUT",
      sent_at: new Date(p.hs_timestamp ?? 0).toISOString(),
      text: p.hs_communication_body ? stripPrefix(p.hs_communication_body) || null : null,
      media_description: null,
      is_template: p.poli_tipo_mensagem === "TEMPLATE",
      template_name: templateName,
      is_prospecting_opener: p.poli_tipo_mensagem === "TEMPLATE" && isProspectingOpener(templateName ?? undefined),
      lead_phone: null,
      lead_name: null,
      lead_uuid: null,
      deprecated_contact_id: null,
      attendant_email: owner?.email ?? null,
      attendant_name: owner?.name ?? null,
      attendant_role: null,
      author_name: null,
      hubspot_contact_id: toContacts.get(c.id)?.[0] ?? null,
      hubspot_deal_ids: toDeals.get(c.id) ?? null,
      outcome: "backfill",
    };
  });

  const comDeal = rows.filter((r) => (r.hubspot_deal_ids?.length ?? 0) > 0).length;
  const comTexto = rows.filter((r) => r.text).length;
  const comAtendente = rows.filter((r) => r.attendant_email).length;
  console.log(`A gravar: ${rows.length} (com texto: ${comTexto}, com atendente: ${comAtendente}, com negócio: ${comDeal})`);
  console.log("Exemplo:", JSON.stringify(rows[0], null, 2).slice(0, 600));

  if (!apply) {
    console.log("\nSimulação — nada foi gravado. Rode de novo com --apply pra aplicar.");
    return;
  }

  let done = 0;
  for (const part of chunk(rows, 500)) {
    await upsertMessages(part, "hubspot_communication_id");
    done += part.length;
    console.log(`  ${done}/${rows.length}`);
  }
  console.log(`\n${rows.length} mensagens gravadas no Supabase.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
