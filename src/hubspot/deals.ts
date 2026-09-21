import { hubspotFetch } from "./client.js";

interface AssociationsResponse {
  results: Array<{ toObjectId: number }>;
}

interface DealBatchReadResponse {
  results: Array<{
    id: string;
    properties: { hs_is_closed_won?: string | null; hs_is_closed_lost?: string | null };
  }>;
}

/**
 * IDs dos negócios (Deal) associados ao contato que ainda estão abertos
 * (não ganhos, não perdidos) — usado pra também associar a Communication a
 * eles, além do Contact.
 */
export async function getOpenDealIdsForContact(contactId: string): Promise<string[]> {
  const associations = await hubspotFetch<AssociationsResponse>(
    `/crm/v4/objects/contacts/${contactId}/associations/deals`,
  );

  const dealIds = associations.results.map((r) => String(r.toObjectId));
  if (dealIds.length === 0) return [];

  const batch = await hubspotFetch<DealBatchReadResponse>("/crm/v3/objects/deals/batch/read", {
    method: "POST",
    body: JSON.stringify({
      properties: ["hs_is_closed_won", "hs_is_closed_lost"],
      inputs: dealIds.map((id) => ({ id })),
    }),
  });

  return batch.results
    .filter((d) => d.properties.hs_is_closed_won !== "true" && d.properties.hs_is_closed_lost !== "true")
    .map((d) => d.id);
}
