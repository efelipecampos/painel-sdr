/**
 * Backfill: corrige "Link do chat na POLI" e "ID do Contato na POLI" nos
 * contatos de negócios abertos (leads ativos) em que um dos dois está vazio
 * ou quebrado (ex.: "https://spa.poli.digital/chat/" sem ID, gerado por
 * workflow quando o ID está em branco).
 *
 * O UUID da Poli é recuperado do próprio contato: do ID, se for um UUID, ou
 * do link, se ele contiver um UUID. Contatos sem UUID em nenhum dos dois só
 * são listados — se corrigem sozinhos na próxima mensagem pela integração.
 *
 * Por padrão só simula. Pra gravar, passe --apply:
 *   npm run backfill:contact-chat-links
 *   npm run backfill:contact-chat-links -- --apply
 */
import { buildPoliChatLink } from "../src/hubspot/contactProperties.js";
import { chunk, hubspotFetch } from "./throttledHubspot.js";

const apply = process.argv.includes("--apply");
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

interface SearchResponse {
  results: Array<{ id: string }>;
  paging?: { next?: { after: string } };
}

interface BatchAssociationsResponse {
  results: Array<{ from: { id: string }; to: Array<{ toObjectId: number }> }>;
}

interface BatchReadResponse {
  results: Array<{ id: string; properties: Record<string, string | null | undefined> }>;
}

async function searchOpenDealIds(): Promise<string[]> {
  const ids: string[] = [];
  let after: string | undefined;
  do {
    const res = await hubspotFetch<SearchResponse>("/crm/v3/objects/deals/search", {
      method: "POST",
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: "hs_is_closed", operator: "EQ", value: "false" }] }],
        properties: ["hs_object_id"],
        limit: 200,
        after,
      }),
    });
    ids.push(...res.results.map((r) => r.id));
    after = res.paging?.next?.after;
  } while (after);
  return ids;
}

async function main() {
  console.log(`Buscando contatos de negócios abertos (${apply ? "APLICANDO" : "simulação"})...`);
  const dealIds = await searchOpenDealIds();

  const contactIds = new Set<string>();
  for (const part of chunk(dealIds, 1000)) {
    const res = await hubspotFetch<BatchAssociationsResponse>("/crm/v4/associations/deals/contacts/batch/read", {
      method: "POST",
      body: JSON.stringify({ inputs: part.map((id) => ({ id })) }),
    });
    for (const r of res.results) for (const t of r.to) contactIds.add(String(t.toObjectId));
  }

  const contacts: BatchReadResponse["results"] = [];
  for (const part of chunk([...contactIds], 100)) {
    const res = await hubspotFetch<BatchReadResponse>("/crm/v3/objects/contacts/batch/read", {
      method: "POST",
      body: JSON.stringify({
        properties: ["firstname", "lastname", "link_do_chat_na_poli", "id_do_contato_na_poli"],
        inputs: part.map((id) => ({ id })),
      }),
    });
    contacts.push(...res.results);
  }
  console.log(`${dealIds.length} negócios abertos, ${contacts.length} contatos.`);

  const updates: Array<{ id: string; name: string; properties: Record<string, string> }> = [];
  const unrecoverable: Array<{ id: string; name: string; link: string }> = [];
  let ok = 0;
  for (const c of contacts) {
    const link = c.properties.link_do_chat_na_poli ?? "";
    const pid = c.properties.id_do_contato_na_poli ?? "";
    const name = `${c.properties.firstname ?? ""} ${c.properties.lastname ?? ""}`.trim();
    const linkUuid = link.match(UUID)?.[0];
    const idIsUuid = UUID.test(pid) && pid.length === 36;

    if (linkUuid && idIsUuid) {
      ok++;
      continue;
    }
    const uuid = idIsUuid ? pid : linkUuid;
    if (!uuid) {
      unrecoverable.push({ id: c.id, name, link: link || "(vazio)" });
      continue;
    }
    const properties: Record<string, string> = {};
    if (!linkUuid) properties.link_do_chat_na_poli = buildPoliChatLink(uuid);
    if (!idIsUuid) properties.id_do_contato_na_poli = uuid;
    updates.push({ id: c.id, name, properties });
  }

  console.log(`Já corretos: ${ok}`);
  console.log(`A corrigir (UUID recuperado do próprio contato): ${updates.length}`);
  for (const u of updates) console.log(`  ${u.id}  ${u.name}  ${JSON.stringify(u.properties)}`);
  console.log(`Sem UUID recuperável (corrigem na próxima mensagem): ${unrecoverable.length}`);
  for (const u of unrecoverable) console.log(`  ${u.id}  ${u.name}  ${u.link}`);

  if (!apply) {
    console.log("\nSimulação — nada foi gravado. Rode de novo com --apply pra aplicar.");
    return;
  }

  for (const part of chunk(updates, 100)) {
    await hubspotFetch("/crm/v3/objects/contacts/batch/update", {
      method: "POST",
      body: JSON.stringify({ inputs: part.map((u) => ({ id: u.id, properties: u.properties })) }),
    });
  }
  console.log(`\n${updates.length} contatos atualizados.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
