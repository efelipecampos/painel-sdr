/**
 * Backfill: preenche o "Link do chat na POLI" (link_do_chat_na_poli) nos
 * negócios que têm mensagens da Poli associadas desde a data informada e
 * estão com o campo em branco. O link vem do contato da mensagem mais recente
 * daquele negócio. Não sobrescreve link já preenchido.
 *
 * Por padrão só simula e imprime o plano. Pra gravar, passe --apply:
 *   npm run backfill:deal-chat-links -- --since 2026-09-18
 *   npm run backfill:deal-chat-links -- --since 2026-09-18 --apply
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

interface BatchReadResponse {
  results: Array<{ id: string; properties: Record<string, string | null | undefined> }>;
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

async function batchRead(objectType: string, ids: string[], properties: string[]): Promise<BatchReadResponse["results"]> {
  const out: BatchReadResponse["results"] = [];
  for (const part of chunk(ids, 100)) {
    const res = await hubspotFetch<BatchReadResponse>(`/crm/v3/objects/${objectType}/batch/read`, {
      method: "POST",
      body: JSON.stringify({ properties, inputs: part.map((id) => ({ id })) }),
    });
    out.push(...res.results);
  }
  return out;
}

async function main() {
  console.log(`Buscando negócios com mensagens da Poli desde ${sinceArg} (${apply ? "APLICANDO" : "simulação"})...`);
  const timestamps = await searchPoliCommunications();
  const commIds = [...timestamps.keys()];
  const commToDeals = await batchAssociations("communications", "deals", commIds);
  const commToContacts = await batchAssociations("communications", "contacts", commIds);

  // Pra cada negócio, o contato da mensagem mais recente associada a ele.
  const latestByDeal = new Map<string, { ts: number; contactId: string }>();
  for (const [commId, dealIds] of commToDeals) {
    const ts = timestamps.get(commId)!;
    const contactId = commToContacts.get(commId)?.[0];
    if (!contactId) continue;
    for (const dealId of dealIds) {
      const current = latestByDeal.get(dealId);
      if (!current || ts > current.ts) latestByDeal.set(dealId, { ts, contactId });
    }
  }
  console.log(`${latestByDeal.size} negócios com mensagens da Poli.`);

  const deals = await batchRead("deals", [...latestByDeal.keys()], ["dealname", "link_do_chat_na_poli"]);
  const blank = deals.filter((d) => !d.properties.link_do_chat_na_poli);
  const contactIds = [...new Set(blank.map((d) => latestByDeal.get(d.id)!.contactId))];
  const contacts = await batchRead("contacts", contactIds, ["link_do_chat_na_poli"]);
  const linkByContact = new Map(contacts.map((c) => [c.id, c.properties.link_do_chat_na_poli || null]));

  const updates: Array<{ id: string; link: string; name: string }> = [];
  let contactWithoutLink = 0;
  for (const d of blank) {
    const link = linkByContact.get(latestByDeal.get(d.id)!.contactId);
    if (!link) {
      contactWithoutLink++;
      continue;
    }
    updates.push({ id: d.id, link, name: d.properties.dealname ?? "" });
  }

  console.log(`Já com link (mantidos): ${deals.length - blank.length}`);
  console.log(`Em branco, mas o contato também está sem link: ${contactWithoutLink}`);
  console.log(`Negócios a preencher: ${updates.length}`);
  for (const u of updates) console.log(`  ${u.id}  ${u.name}  ->  ${u.link}`);

  if (!apply) {
    console.log("\nSimulação — nada foi gravado. Rode de novo com --apply pra aplicar.");
    return;
  }

  for (const part of chunk(updates, 100)) {
    await hubspotFetch("/crm/v3/objects/deals/batch/update", {
      method: "POST",
      body: JSON.stringify({
        inputs: part.map((u) => ({ id: u.id, properties: { link_do_chat_na_poli: u.link } })),
      }),
    });
  }
  console.log(`\n${updates.length} negócios atualizados.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
