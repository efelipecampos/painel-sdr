import { hubspotFetch } from "./client.js";
import { getDefaultAssociationTypeId } from "./associations.js";
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
  const label = message.direction === "IN" ? "Lead" : (message.attendantName ?? message.authorName ?? "SDR");
  return `[${label}] ${message.text}`;
}

export async function createCommunication({ contactId, message, ownerId }: CreateCommunicationParams): Promise<string> {
  const associationTypeId = await getDefaultAssociationTypeId("communications", "contacts");

  const properties: Record<string, string> = {
    hs_communication_channel_type: "WHATS_APP",
    hs_communication_logged_from: "CRM",
    hs_communication_body: buildCommunicationBody(message),
    hs_timestamp: String(message.timestampMs),
  };
  if (message.direction === "OUT" && ownerId) {
    properties.hubspot_owner_id = ownerId;
  }

  const res = await hubspotFetch<CommunicationCreateResponse>("/crm/v3/objects/communications", {
    method: "POST",
    body: JSON.stringify({
      properties,
      associations: [
        {
          to: { id: contactId },
          types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId }],
        },
      ],
    }),
  });

  return res.id;
}
