import { hubspotFetch } from "./client.js";
import { brazilianPhoneCandidates, corePhoneDigits, phoneSuffix } from "./phone.js";
import { extractCompanyFromLeadName } from "./companyName.js";
import { logger } from "../logger.js";

interface ContactSearchResponse {
  total: number;
  results: Array<{ id: string; properties: Record<string, string | null> }>;
}

async function searchContacts(filterGroups: unknown[], properties: string[], limit: number): Promise<ContactSearchResponse> {
  return hubspotFetch<ContactSearchResponse>("/crm/v3/objects/contacts/search", {
    method: "POST",
    body: JSON.stringify({ filterGroups, properties, limit }),
  });
}

/**
 * Tier 0: campo customizado `id_do_contato_na_poli`, populado
 * historicamente num bulk (~49 mil contatos, ID numérico legado) e, cada
 * vez mais, pelo backfill que esta própria integração faz (UUID novo) ao
 * resolver um contato pelas outras camadas. Match exato e sem ambiguidade —
 * tenta os dois formatos (numérico legado e UUID) porque coexistem hoje.
 */
async function findByPoliId(leadUuid: string, deprecatedContactId?: string): Promise<string | null> {
  const values = [leadUuid, deprecatedContactId].filter((v): v is string => Boolean(v));
  if (values.length === 0) return null;

  const res = await searchContacts(
    [{ filters: [{ propertyName: "id_do_contato_na_poli", operator: "IN", values }] }],
    ["id_do_contato_na_poli"],
    1,
  );

  return res.results[0]?.id ?? null;
}

/** Tier 1: telefone salvo sem pontuação (ex: "+5511987654321") — casa exato contra as variações geradas. */
async function findByExactCandidates(rawPhone: string): Promise<string | null> {
  const candidates = brazilianPhoneCandidates(rawPhone);
  if (candidates.length === 0) return null;

  const res = await searchContacts(
    [
      { filters: [{ propertyName: "phone", operator: "IN", values: candidates }] },
      { filters: [{ propertyName: "mobilephone", operator: "IN", values: candidates }] },
    ],
    ["phone", "mobilephone"],
    1,
  );

  return res.results[0]?.id ?? null;
}

/**
 * Tier 2: telefone salvo com pontuação (ex: "+55(11) 98765-4321") — a busca
 * exata do Tier 1 não bate porque a string é diferente. Busca uma lista
 * ampla via CONTAINS_TOKEN nos últimos 4 dígitos (que o HubSpot tokeniza
 * como um bloco separado quando há traço/espaço/parênteses) e confirma cada
 * candidato comparando o número "core" (sem DDI, sem pontuação, sem o 9º
 * dígito) — só aceita se o core bater exatamente, pra não associar ao
 * contato errado.
 */
async function findByFuzzySuffix(rawPhone: string): Promise<string | null> {
  const suffix = phoneSuffix(rawPhone, 4);
  if (suffix.length < 4) return null;

  const targetCore = corePhoneDigits(rawPhone);
  if (!targetCore) return null;

  const res = await searchContacts(
    [
      { filters: [{ propertyName: "phone", operator: "CONTAINS_TOKEN", value: suffix }] },
      { filters: [{ propertyName: "mobilephone", operator: "CONTAINS_TOKEN", value: suffix }] },
    ],
    ["phone", "mobilephone"],
    50,
  );

  const matches = res.results.filter((r) => {
    const phone = r.properties.phone ?? "";
    const mobile = r.properties.mobilephone ?? "";
    return corePhoneDigits(phone) === targetCore || corePhoneDigits(mobile) === targetCore;
  });

  if (matches.length > 1) {
    logger.warn(
      { rawPhone, matchCount: matches.length, contactIds: matches.map((m) => m.id) },
      "Busca ampla de telefone encontrou mais de um contato com o mesmo core — usando o primeiro",
    );
  }

  return matches[0]?.id ?? null;
}

/**
 * Tier 3: último recurso, sem telefone confiável — busca pelo nome da
 * empresa extraído de lead_name (ver companyName.ts). Só aceita se achar
 * exatamente UM contato: em caso de ambiguidade (nome de empresa comum,
 * duplicatas), prefere não achar a associar errado.
 */
async function findByCompanyName(leadName: string | undefined): Promise<string | null> {
  const company = extractCompanyFromLeadName(leadName);
  if (!company) return null;

  const res = await searchContacts(
    [{ filters: [{ propertyName: "company", operator: "CONTAINS_TOKEN", value: company }] }],
    ["company"],
    10,
  );

  const uniqueContactIds = new Set(res.results.map((r) => r.id));
  if (uniqueContactIds.size === 0) return null;
  if (uniqueContactIds.size > 1) {
    logger.warn(
      { company, matchCount: uniqueContactIds.size },
      "Busca por empresa ambígua (mais de um contato), ignorando",
    );
    return null;
  }

  return res.results[0]?.id ?? null;
}

export type ContactMatchTier = "POLI_ID" | "EXACT_PHONE" | "FUZZY_PHONE" | "COMPANY_NAME";

export interface ContactMatch {
  contactId: string;
  matchedVia: ContactMatchTier;
}

export interface FindContactInput {
  leadPhone: string;
  leadName?: string;
  leadUuid: string;
  deprecatedContactId?: string;
}

/**
 * Procura um Contact no HubSpot em ordem de confiabilidade: id/uuid salvo
 * (Tier 0), telefone exato (Tier 1), telefone com pontuação (Tier 2) e, por
 * último, nome da empresa (Tier 3). Só retorna null depois de tentar todas.
 */
export async function findContact({
  leadPhone,
  leadName,
  leadUuid,
  deprecatedContactId,
}: FindContactInput): Promise<ContactMatch | null> {
  const byId = await findByPoliId(leadUuid, deprecatedContactId);
  if (byId) return { contactId: byId, matchedVia: "POLI_ID" };

  const exact = await findByExactCandidates(leadPhone);
  if (exact) return { contactId: exact, matchedVia: "EXACT_PHONE" };

  const fuzzy = await findByFuzzySuffix(leadPhone);
  if (fuzzy) return { contactId: fuzzy, matchedVia: "FUZZY_PHONE" };

  const byCompany = await findByCompanyName(leadName);
  if (byCompany) return { contactId: byCompany, matchedVia: "COMPANY_NAME" };

  return null;
}
