import { hubspotFetch } from "./client.js";
import { getDefaultAssociationTypeId } from "./associations.js";
import { getOpenDealIdsForContact } from "./deals.js";
import { logger } from "../logger.js";
import type { MessageEvent } from "../poli/parser.js";

interface CommunicationCreateResponse {
  id: string;
}

export interface CreateCommunicationParams {
  contactId: string;
  message: MessageEvent;
  ownerId?: string;
}

export function buildCommunicationBody(message: MessageEvent): string {
  const label = message.direction === "IN" ? "Recebida" : "Enviada";
  return `[${label}] ${message.text}`;
}

export async function createCommunication({ contactId, message, ownerId }: CreateCommunicationParams): Promise<string> {
  const contactAssociationTypeId = await getDefaultAssociationTypeId("communications", "contacts");

  const associations: Array<{ to: { id: string }; types: Array<{ associationCategory: string; associationTypeId: number }> }> = [
    {
      to: { id: contactId },
      types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: contactAssociationTypeId }],
    },
  ];

  try {
    const openDealIds = await getOpenDealIdsForContact(contactId);
    if (openDealIds.length > 0) {
      const dealAssociationTypeId = await getDefaultAssociationTypeId("communications", "deals");
      for (const dealId of openDealIds) {
        associations.push({
          to: { id: dealId },
          types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: dealAssociationTypeId }],
        });
      }
    }
  } catch (err) {
    // Não deixa a falha de associar negócio impedir o registro da mensagem
    // em si — o contato já garante a associação mínima.
    logger.warn({ err, contactId }, "Falha ao buscar/associar negócios abertos do contato, seguindo só com o Contact");
  }

  const properties: Record<string, string> = {
    hs_communication_channel_type: "WHATS_APP",
    hs_communication_logged_from: "CRM",
    hs_communication_body: buildCommunicationBody(message),
    hs_timestamp: String(message.timestampMs),
    // Propriedade customizada própria pra direção (a Communications API não
    // tem um campo nativo de direção) — fica filtrável/reportável no
    // registro, além do prefixo no corpo pra leitura rápida no timeline.
    poli_direcao: message.direction === "IN" ? "RECEBIDA" : "ENVIADA",
    poli_tipo_mensagem: message.isTemplate ? "TEMPLATE" : "LIVRE",
  };
  if (message.direction === "OUT" && ownerId) {
    properties.hubspot_owner_id = ownerId;
  }
  if (message.isTemplate && message.templateName) {
    properties.poli_nome_template = message.templateName;
  }

  const res = await hubspotFetch<CommunicationCreateResponse>("/crm/v3/objects/communications", {
    method: "POST",
    body: JSON.stringify({ properties, associations }),
  });

  return res.id;
}
