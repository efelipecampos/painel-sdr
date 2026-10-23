/**
 * Backfill: associa aos negócios (Deal) as Communications da Poli que foram
 * criadas só com associação ao Contact (antes da associação a negócios
 * existir, ou enquanto faltava o escopo crm.objects.deals.read).
 *
 * Regra: um negócio do contato recebe a mensagem se estava aberto no momento
 * dela — criado antes da mensagem e ainda não fechado (ou fechado depois).
 * Equivale ao que o fluxo ao vivo teria feito na hora.
 *
 * Por padrão só simula e imprime o plano. Pra gravar, passe --apply:
 *   npm run backfill:deal-associations -- --since 2026-09-18
 *   npm run backfill:deal-associations -- --since 2026-09-18 --apply
 */
import { chunk, hubspotFetch } from "./throttledHubspot.js";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const sinceArg = args[args.indexOf("--since") + 1];
if (!args.includes("--since") || !sinceArg) {
  console.error("Uso: --since AAAA-MM-DD [--apply]");
  process.exit(1);
}
// Meia-noite no horário de Brasília (-03:00).
const sinceMs = new Date(`${sinceArg}T00:00:00-03:00`).getTime();

interface SearchResponse {
  results: Array<{ id: string; properties: { hs_timestamp: string } }>;
  paging?: { next?: { after: string } };
}

interface BatchAssociationsResponse {
  results: Array<{ from: { id: string }; to: Array<{ toObjectId: number }> }>;
}

interface DealBatchReadResponse {
  results: Array<{
    id: string;
    properties: { dealname?: string; createdate?: string; closedate?: string | null; hs_is_closed?: string };
  }>;
}

async function searchPoliCommunications(): Promise<Map<string, number>> {
  const timestamps = new Map<string, number>();
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
        properties: ["hs_timestamp"],
        sorts: [{ propertyName: "hs_timestamp", direction: "ASCENDING" }],
        limit: 200,
        after,
      }),
    });
    for (const r of res.results) timestamps.set(r.id, new Date(r.properties.hs_timestamp).getTime());
    after = res.paging?.next?.after;
  } while (after);
  return timestamps;
}

async function batchAssociations(from: string, to: string, ids: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  for (const part of chunk(ids, 1000)) {
    const res = await hubspotFetch<BatchAssociationsResponse>(`/crm/v4/associations/${from}/${to}/batch/read`, {
      method: "POST",
      body: JSON.stringify({ inputs: part.map((id) => ({ id })) }),
    });
    for (const r of res.results) map.set(r.from.id, r.to.map((t) => String(t.toObjectId)));
  }
  return map;
}

async function readDeals(ids: string[]): Promise<Map<string, DealBatchReadResponse["results"][number]["properties"]>> {
  const map = new Map<string, DealBatchReadResponse["results"][number]["properties"]>();
  for (const part of chunk(ids, 100)) {
    const res = await hubspotFetch<DealBatchReadResponse>("/crm/v3/objects/deals/batch/read", {
      method: "POST",
      body: JSON.stringify({
        properties: ["dealname", "createdate", "closedate", "hs_is_closed"],
        inputs: part.map((id) => ({ id })),
      }),
    });
    for (const d of res.results) map.set(d.id, d.properties);
  }
  return map;
}

function wasOpenAt(deal: DealBatchReadResponse["results"][number]["properties"], ts: number): boolean {
  const created = deal.createdate ? new Date(deal.createdate).getTime() : 0;
  if (created > ts) return false;
  if (deal.hs_is_closed !== "true") return true;
  const closed = deal.closedate ? new Date(deal.closedate).getTime() : 0;
  return closed > ts;
}

async function main() {
  console.log(`Buscando Communications da Poli desde ${sinceArg} (${apply ? "APLICANDO" : "simulação"})...`);
  const timestamps = await searchPoliCommunications();
  const commIds = [...timestamps.keys()];
  console.log(`${commIds.length} mensagens encontradas.`);
  if (commIds.length === 0) return;

  const commToContacts = await batchAssociations("communications", "contacts", commIds);
  const commToDeals = await batchAssociations("communications", "deals", commIds);
  const contactIds = [...new Set([...commToContacts.values()].flat())];
  const contactToDeals = await batchAssociations("contacts", "deals", contactIds);
  const dealIds = [...new Set([...contactToDeals.values()].flat())];
  const deals = await readDeals(dealIds);

  const toCreate: Array<{ commId: string; dealId: string }> = [];
  let alreadyAssociated = 0;
  let contactWithoutDeal = 0;
  for (const commId of commIds) {
    const ts = timestamps.get(commId)!;
    const existing = new Set(commToDeals.get(commId) ?? []);
    const candidates = (commToContacts.get(commId) ?? []).flatMap((c) => contactToDeals.get(c) ?? []);
    if (candidates.length === 0) contactWithoutDeal++;
    for (const dealId of new Set(candidates)) {
      const deal = deals.get(dealId);
      if (!deal || !wasOpenAt(deal, ts)) continue;
      if (existing.has(dealId)) {
        alreadyAssociated++;
        continue;
      }
      toCreate.push({ commId, dealId });
    }
  }

  const perDeal = new Map<string, number>();
  for (const { dealId } of toCreate) perDeal.set(dealId, (perDeal.get(dealId) ?? 0) + 1);
  console.log(`Mensagens cujo contato não tem negócio: ${contactWithoutDeal}`);
  console.log(`Associações já existentes (puladas): ${alreadyAssociated}`);
  console.log(`Associações a criar: ${toCreate.length} em ${perDeal.size} negócios`);
  for (const [dealId, n] of [...perDeal].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${dealId}  ${deals.get(dealId)?.dealname ?? ""}`);
  }

  if (!apply) {
    console.log("\nSimulação — nada foi gravado. Rode de novo com --apply pra aplicar.");
    return;
  }

  for (const part of chunk(toCreate, 100)) {
    await hubspotFetch("/crm/v4/associations/communications/deals/batch/associate/default", {
      method: "POST",
      body: JSON.stringify({ inputs: part.map(({ commId, dealId }) => ({ from: { id: commId }, to: { id: dealId } })) }),
    });
  }
  console.log(`\n${toCreate.length} associações criadas.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
