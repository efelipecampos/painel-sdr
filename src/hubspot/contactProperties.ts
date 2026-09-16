import { hubspotFetch } from "./client.js";
import type { MessageEvent } from "../poli/parser.js";

/**
 * Atualiza as propriedades do Contact que dão visibilidade ao SDR dentro do
 * próprio HubSpot (fila "aguardando minha resposta" via poli_awaiting_reply).
 * Ver seção "Modelo de dados no HubSpot" do plano.
 */
export async function updatePoliContactProperties(contactId: string, message: MessageEvent): Promise<void> {
  await hubspotFetch(`/crm/v3/objects/contacts/${contactId}`, {
    method: "PATCH",
    body: JSON.stringify({
      properties: {
        poli_last_message_at: String(message.timestampMs),
        poli_last_message_direction: message.direction === "IN" ? "RECEIVED" : "SENT",
        poli_awaiting_reply: message.direction === "IN" ? "true" : "false",
      },
    }),
  });
}
