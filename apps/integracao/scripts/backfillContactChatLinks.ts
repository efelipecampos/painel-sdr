/**
 * Backfill: corrige "Link do chat na POLI" e "ID do Contato na POLI" nos
 * contatos em que um dos dois está vazio ou quebrado (ex.:
 * "https://spa.poli.digital/chat/" sem ID, gerado por workflow quando o ID
 * estava em branco).
 *
 * Alvo (um dos dois):
 *   (padrão)                   contatos de negócios abertos (leads ativos)
 *   --created-since AAAA-MM-DD contatos criados a partir da data
 *
 * O UUID da Poli é recuperado do próprio contato, nessa ordem: ID atual (se
 * for UUID), link atual (se contiver UUID), e por fim o histórico desses dois
 * campos — outra integração às vezes apaga o ID, mas o valor antigo fica no
 * histórico. Contatos sem UUID em lugar nenhum só são listados; se corrigem
 * na próxima mensagem pela integração.
 *
 * Por padrão só simula. Pra gravar, passe --apply.
 *   npm run backfill:contact-chat-links -- --created-since 2026-09-01
 *   npm run backfill:contact-chat-links -- --created-since 2026-09-01 --apply
 */
import { buildPoliChatLink } from "../src/hubspot/contactProperties.js";
import { chunk, hubspotFetch } from "./throttledHubspot.js";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const createdSinceArg = args.includes("--created-since") ? args[args.indexOf("--created-since") + 1] : undefined;
if (args.includes("--created-since") && !createdSinceArg) {
  console.error("Uso: [--created-since AAAA-MM-DD] [--apply]");
  process.exit(1);
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const LINK = "link_do_chat_na_poli";
const ID = "id_do_contato_na_poli";

interface SearchResponse {
  results: Array<{ id: string }>;
  paging?: { next?: { after: string } };
}

interface BatchAssociationsResponse {
  results: Array<{ from: { id: string }; to: Array<{ toObjectId: number }> }>;
}

interface HistoryEntry {
  value: string;
  timestamp: string;
}

interface ContactWithHistory {
  id: string;
  properties: Record<string, string | null | undefined>;
  propertiesWithHistory?: Record<string, HistoryEntry[]>;
}

async function searchIds(objectType: string, filters: object[]): Promise<string[]> {
  const ids: string[] = [];
  let after: string | undefined;
  do {
    const res = await hubspotFetch<SearchResponse>(`/crm/v3/objects/${objectType}/search`, {
      method: "POST",
      body: JSON.stringify({ filterGroups: [{ filters }], properties: ["hs_object_id"], limit: 200, after }),
    });
    ids.push(...res.results.map((r) => r.id));
    after = res.paging?.next?.after;
  } while (after);
  return ids;
}

async function contactsOfOpenDeals(): Promise<string[]> {
  const dealIds = await searchIds("deals", [{ propertyName: "hs_is_closed", operator: "EQ", value: "false" }]);
  const contactIds = new Set<string>();
  for (const part of chunk(dealIds, 1000)) {
    const res = await hubspotFetch<BatchAssociationsResponse>("/crm/v4/associations/deals/contacts/batch/read", {
      method: "POST",
      body: JSON.stringify({ inputs: part.map((id) => ({ id })) }),
    });
    for (const r of res.results) for (const t of r.to) contactIds.add(String(t.toObjectId));
  }
  console.log(`${dealIds.length} negócios abertos.`);
  return [...contactIds];
}

async function readWithHistory(ids: string[]): Promise<ContactWithHistory[]> {
  const out: ContactWithHistory[] = [];
  // Com propertiesWithHistory o batch read aceita no máximo 50 por chamada.
  for (const part of chunk(ids, 50)) {
    const res = await hubspotFetch<{ results: ContactWithHistory[] }>("/crm/v3/objects/contacts/batch/read", {
      method: "POST",
      body: JSON.stringify({
        properties: ["firstname", "lastname", LINK, ID],
        propertiesWithHistory: [LINK, ID],
        inputs: part.map((id) => ({ id })),
      }),
    });
    out.push(...res.results);
  }
  return out;
}

function uuidFromHistory(c: ContactWithHistory): string | undefined {
  const entries = [...(c.propertiesWithHistory?.[ID] ?? []), ...(c.propertiesWithHistory?.[LINK] ?? [])].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );
  for (const e of entries) {
    const m = e.value?.match(UUID)?.[0];
    if (m) return m;
  }
  return undefined;
}

async function main() {
  const target = createdSinceArg ? `contatos criados desde ${createdSinceArg}` : "contatos de negócios abertos";
  console.log(`Buscando ${target} (${apply ? "APLICANDO" : "simulação"})...`);
  const contactIds = createdSinceArg
    ? await searchIds("contacts", [
        {
          propertyName: "createdate",
          operator: "GTE",
          value: String(new Date(`${createdSinceArg}T00:00:00-03:00`).getTime()),
        },
      ])
    : await contactsOfOpenDeals();
  const contacts = await readWithHistory(contactIds);
  console.log(`${contacts.length} contatos.`);

  const updates: Array<{ id: string; name: string; source: string; properties: Record<string, string> }> = [];
  const unrecoverable: Array<{ id: string; name: string; link: string }> = [];
  let ok = 0;
  for (const c of contacts) {
    const link = c.properties[LINK] ?? "";
    const pid = c.properties[ID] ?? "";
    const name = `${c.properties.firstname ?? ""} ${c.properties.lastname ?? ""}`.trim();
    const linkUuid = link.match(UUID)?.[0];
    const idIsUuid = UUID.test(pid) && pid.length === 36;

    if (linkUuid && idIsUuid) {
      ok++;
      continue;
    }
    let uuid = idIsUuid ? pid : linkUuid;
    let source = "atual";
    if (!uuid) {
      uuid = uuidFromHistory(c);
      source = "histórico";
    }
    if (!uuid) {
      unrecoverable.push({ id: c.id, name, link: link || "(vazio)" });
      continue;
    }
    const properties: Record<string, string> = {};
    if (!linkUuid) properties[LINK] = buildPoliChatLink(uuid);
    if (!idIsUuid) properties[ID] = uuid;
    updates.push({ id: c.id, name, source, properties });
  }

  const fromHistory = updates.filter((u) => u.source === "histórico").length;
  console.log(`Já corretos: ${ok}`);
  console.log(`A corrigir: ${updates.length} (UUID atual no próprio contato: ${updates.length - fromHistory}, recuperado do histórico: ${fromHistory})`);
  for (const u of updates) console.log(`  ${u.id}  [${u.source}]  ${u.name}  ${JSON.stringify(u.properties)}`);
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
