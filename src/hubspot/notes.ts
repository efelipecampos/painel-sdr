import { hubspotFetch } from "./client.js";
import { getDefaultAssociationTypeId } from "./associations.js";

interface NoteCreateResponse {
  id: string;
}

export interface CreateNoteParams {
  contactId: string;
  body: string;
  timestampMs: number;
}

/**
 * Cria uma Note no contato. Diferente das Communications, Notes entram nas
 * funcionalidades de IA do HubSpot (preenchimento de campo, resumo), que é
 * pra isso que a nota diária existe.
 */
export async function createNote({ contactId, body, timestampMs }: CreateNoteParams): Promise<string> {
  const associationTypeId = await getDefaultAssociationTypeId("notes", "contacts");

  const res = await hubspotFetch<NoteCreateResponse>("/crm/v3/objects/notes", {
    method: "POST",
    body: JSON.stringify({
      properties: { hs_timestamp: String(timestampMs), hs_note_body: body },
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
