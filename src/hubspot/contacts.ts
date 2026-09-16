import { hubspotFetch } from "./client.js";
import { brazilianPhoneCandidates } from "./phone.js";

interface ContactSearchResponse {
  total: number;
  results: Array<{ id: string; properties: Record<string, string | null> }>;
}

/**
 * Procura um Contact no HubSpot cujo phone ou mobilephone bata com alguma
 * variação plausível do número recebido da Poli. Retorna o id do primeiro
 * contato encontrado, ou null se nenhum bater.
 */
export async function findContactIdByPhone(rawPhone: string): Promise<string | null> {
  const candidates = brazilianPhoneCandidates(rawPhone);
  if (candidates.length === 0) return null;

  const res = await hubspotFetch<ContactSearchResponse>("/crm/v3/objects/contacts/search", {
    method: "POST",
    body: JSON.stringify({
      filterGroups: [
        { filters: [{ propertyName: "phone", operator: "IN", values: candidates }] },
        { filters: [{ propertyName: "mobilephone", operator: "IN", values: candidates }] },
      ],
      properties: ["phone", "mobilephone"],
      limit: 1,
    }),
  });

  return res.results[0]?.id ?? null;
}
