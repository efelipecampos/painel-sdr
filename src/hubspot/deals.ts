import { hubspotFetch } from "./client.js";
import {
  CYCLE_HOURS,
  CYCLE_REPLIED_AT,
  CYCLE_START_AT,
  CYCLE_TEMPLATE,
  type CompletedCycle,
} from "../pipeline/prospectingCycle.js";

interface AssociationsResponse {
  results: Array<{ toObjectId: number }>;
}

interface DealBatchReadResponse {
  results: Array<{
    id: string;
    properties: {
      hs_is_closed_won?: string | null;
      hs_is_closed_lost?: string | null;
      link_do_chat_na_poli?: string | null;
    };
  }>;
}

export interface OpenDeal {
  id: string;
  chatLink: string | null;
}

/**
 * Negócios (Deal) associados ao contato que ainda estão abertos (não ganhos,
 * não perdidos) — usados pra também associar a Communication a eles, além do
 * Contact, e pra preencher o link do chat na Poli no negócio.
 */
export async function getOpenDealsForContact(contactId: string): Promise<OpenDeal[]> {
  const associations = await hubspotFetch<AssociationsResponse>(
    `/crm/v4/objects/contacts/${contactId}/associations/deals`,
  );

  const dealIds = associations.results.map((r) => String(r.toObjectId));
  if (dealIds.length === 0) return [];

  const batch = await hubspotFetch<DealBatchReadResponse>("/crm/v3/objects/deals/batch/read", {
    method: "POST",
    body: JSON.stringify({
      properties: ["hs_is_closed_won", "hs_is_closed_lost", "link_do_chat_na_poli"],
      inputs: dealIds.map((id) => ({ id })),
    }),
  });

  return batch.results
    .filter((d) => d.properties.hs_is_closed_won !== "true" && d.properties.hs_is_closed_lost !== "true")
    .map((d) => ({ id: d.id, chatLink: d.properties.link_do_chat_na_poli || null }));
}

/**
 * Preenche o link do chat na Poli nos negócios em que ele está em branco.
 * Não sobrescreve link já preenchido (à mão ou por outro contato do negócio).
 */
export async function fillMissingDealChatLinks(deals: OpenDeal[], chatLink: string): Promise<string[]> {
  const missing = deals.filter((d) => !d.chatLink).map((d) => d.id);
  if (missing.length === 0) return [];

  await hubspotFetch("/crm/v3/objects/deals/batch/update", {
    method: "POST",
    body: JSON.stringify({
      inputs: missing.map((id) => ({ id, properties: { link_do_chat_na_poli: chatLink } })),
    }),
  });
  return missing;
}

/**
 * Copia o ciclo de prospecção que acabou de fechar pros negócios abertos do
 * contato. No contato os campos são sobrescritos pelo próximo ciclo; no
 * negócio ficam os dados do ciclo daquela oportunidade.
 */
export async function writeCycleToDeals(deals: OpenDeal[], cycle: CompletedCycle): Promise<string[]> {
  if (deals.length === 0) return [];

  await hubspotFetch("/crm/v3/objects/deals/batch/update", {
    method: "POST",
    body: JSON.stringify({
      inputs: deals.map((d) => ({
        id: d.id,
        properties: {
          [CYCLE_START_AT]: String(cycle.startedAtMs),
          [CYCLE_REPLIED_AT]: String(cycle.repliedAtMs),
          [CYCLE_HOURS]: String(cycle.hours),
          [CYCLE_TEMPLATE]: cycle.templateName ?? "",
        },
      })),
    }),
  });
  return deals.map((d) => d.id);
}
