/**
 * Backfill: pra contatos do HubSpot sem UUID da Poli em lugar nenhum (link
 * quebrado/vazio e ID vazio), busca o contato na API da Poli pelo telefone e
 * grava "ID do Contato na POLI" + "Link do chat na POLI".
 *
 * Só grava quando a Poli devolve exatamente UM contato com o mesmo número
 * (comparando DDD + 8 dígitos, ignorando DDI, 9º dígito e formatação).
 * Nenhum resultado ou resultado ambíguo só é listado.
 *
 * Requer POLI_API_TOKEN no .env (POLI_ACCOUNT_UUID é opcional — sem ele, usa a
 * única conta que o token enxerga).
 *
 * Por padrão só simula. --limit N processa só os N primeiros (pra testar).
 *   npm run backfill:contact-chat-links-poli -- --created-since 2026-09-01 --limit 10
 *   npm run backfill:contact-chat-links-poli -- --created-since 2026-09-01 --apply
 */
import "dotenv/config";
import { buildPoliChatLink } from "../src/hubspot/contactProperties.js";
import { corePhoneDigits } from "../src/hubspot/phone.js";
import { chunk, hubspotFetch } from "./throttledHubspot.js";

const POLI_BASE_URL = "https://foundation-api.poli.digital/v3";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const createdSinceArg = args[args.indexOf("--created-since") + 1];
const limit = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : Infinity;
if (!args.includes("--created-since") || !createdSinceArg) {
  console.error("Uso: --created-since AAAA-MM-DD [--limit N] [--apply]");
  process.exit(1);
}
const poliToken = process.env.POLI_API_TOKEN;
if (!poliToken) {
  console.error("Falta POLI_API_TOKEN no .env");
  process.exit(1);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function poliFetch<T>(path: string): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    await sleep(500);
    const res = await fetch(`${POLI_BASE_URL}${path}`, {
      headers: { Authorization: `Bearer ${poliToken}`, Accept: "application/json" },
    });
    if (res.status === 429 && attempt < 8) {
      await sleep(3000 * attempt);
      continue;
    }
    if (!res.ok) throw new Error(`Poli API ${res.status} em ${path}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as T;
  }
}

interface PoliContact {
  uuid: string;
  attributes?: { name?: string; phone?: string | null };
  channels?: Array<{ uid?: string; provider?: string }>;
  contact_channels?: Array<{ uid?: string; provider?: string }>;
}

async function resolveAccountUuid(): Promise<string> {
  if (process.env.POLI_ACCOUNT_UUID) return process.env.POLI_ACCOUNT_UUID;
  const res = await poliFetch<{ data: Array<{ uuid: string; attributes?: { name?: string } }> }>(
    "/accounts?include=attributes",
  );
  if (res.data.length !== 1) {
    console.error("O token enxerga mais de uma conta; defina POLI_ACCOUNT_UUID no .env. Contas:");
    for (const a of res.data) console.error(`  ${a.uuid}  ${a.attributes?.name ?? ""}`);
    process.exit(1);
  }
  return res.data[0].uuid;
}

function phonesOf(c: PoliContact): string[] {
  return [c.attributes?.phone, ...(c.channels ?? []).map((ch) => ch.uid), ...(c.contact_channels ?? []).map((ch) => ch.uid)]
    .filter((p): p is string => !!p);
}

async function findPoliUuidByPhone(accountUuid: string, phone: string): Promise<{ uuid?: string; reason: string }> {
  const core = corePhoneDigits(phone);
  if (core.length !== 10) return { reason: "telefone inválido" };

  // A busca textual da Poli não é garantida pra todo formato de número —
  // tenta do mais específico pro mais amplo e confirma pelo "core".
  const digits = phone.replace(/\D+/g, "");
  const terms = [...new Set([digits.startsWith("55") ? digits : `55${digits}`, core.slice(2)])];
  for (const term of terms) {
    const res = await poliFetch<{ data: PoliContact[] }>(
      `/accounts/${accountUuid}/contacts?include=attributes,contact_channels&per_page=100&search=${encodeURIComponent(term)}`,
    );
    const matches = [...new Set(res.data.filter((c) => phonesOf(c).some((p) => corePhoneDigits(p) === core)).map((c) => c.uuid))];
    if (matches.length === 1) return { uuid: matches[0], reason: `busca "${term}"` };
    if (matches.length > 1) return { reason: `ambíguo (${matches.length} contatos na Poli)` };
  }
  return { reason: "não encontrado na Poli" };
}

interface SearchResponse {
  results: Array<{ id: string; properties: Record<string, string | null | undefined> }>;
  paging?: { next?: { after: string } };
}

async function brokenHubspotContacts() {
  const out: SearchResponse["results"] = [];
  let after: string | undefined;
  do {
    const res = await hubspotFetch<SearchResponse>("/crm/v3/objects/contacts/search", {
      method: "POST",
      body: JSON.stringify({
        filterGroups: [
          {
            filters: [
              {
                propertyName: "createdate",
                operator: "GTE",
                value: String(new Date(`${createdSinceArg}T00:00:00-03:00`).getTime()),
              },
            ],
          },
        ],
        properties: ["firstname", "lastname", "phone", "mobilephone", "hs_whatsapp_phone_number", "link_do_chat_na_poli", "id_do_contato_na_poli"],
        limit: 200,
        after,
      }),
    });
    out.push(...res.results);
    after = res.paging?.next?.after;
  } while (after);

  return out.filter((c) => {
    const linkUuid = (c.properties.link_do_chat_na_poli ?? "").match(UUID);
    const pid = c.properties.id_do_contato_na_poli ?? "";
    return !linkUuid && !(UUID.test(pid) && pid.length === 36);
  });
}

async function main() {
  console.log(`Contatos criados desde ${createdSinceArg} sem UUID da Poli (${apply ? "APLICANDO" : "simulação"})...`);
  const accountUuid = await resolveAccountUuid();
  const broken = (await brokenHubspotContacts()).slice(0, limit);
  console.log(`${broken.length} contatos a consultar na Poli.`);

  const updates: Array<{ id: string; properties: Record<string, string> }> = [];
  const reasons = new Map<string, number>();
  let i = 0;
  for (const c of broken) {
    i++;
    const name = `${c.properties.firstname ?? ""} ${c.properties.lastname ?? ""}`.trim();
    const phone = c.properties.hs_whatsapp_phone_number || c.properties.mobilephone || c.properties.phone;
    const result = phone ? await findPoliUuidByPhone(accountUuid, phone) : { reason: "sem telefone no HubSpot" };
    const key = result.uuid ? "encontrado" : result.reason;
    reasons.set(key, (reasons.get(key) ?? 0) + 1);
    console.log(`  [${i}/${broken.length}] ${c.id}  ${name}  ${phone ?? "-"}  ->  ${result.uuid ?? result.reason}`);
    if (result.uuid) {
      updates.push({
        id: c.id,
        properties: { id_do_contato_na_poli: result.uuid, link_do_chat_na_poli: buildPoliChatLink(result.uuid) },
      });
    }
  }

  console.log("\nResumo:");
  for (const [k, n] of [...reasons].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${k}`);

  if (!apply) {
    console.log("\nSimulação — nada foi gravado. Rode de novo com --apply pra aplicar.");
    return;
  }
  for (const part of chunk(updates, 100)) {
    await hubspotFetch("/crm/v3/objects/contacts/batch/update", {
      method: "POST",
      body: JSON.stringify({ inputs: part }),
    });
  }
  console.log(`\n${updates.length} contatos atualizados.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
