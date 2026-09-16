import type { PoliWebhookBody } from "./types.js";

export interface MessageEvent {
  /** Chave de dedupe: wamid do WhatsApp quando disponível, senão o uuid da mensagem. */
  externalMessageId: string;
  direction: "IN" | "OUT";
  timestampMs: number;
  text: string;
  leadPhone: string;
  leadName?: string;
  /** E-mail de quem está atendendo a conversa na Poli, IN ou OUT — é o campo usado pro filtro de equipe. */
  attendantEmail?: string;
  attendantName?: string;
  /** Nome de quem efetivamente mandou essa mensagem (lead ou atendente). */
  authorName?: string;
}

export function parseMessageEvent(body: PoliWebhookBody): MessageEvent {
  const { value } = body;

  return {
    externalMessageId: value.metadata.external_message_id ?? value.uuid,
    direction: value.direction,
    timestampMs: value.timestamp * 1000,
    text: value.components.body?.text ?? "",
    leadPhone: value.contact.attributes.phone,
    leadName: value.contact.attributes.name,
    attendantEmail: value.attendance?.attendant?.email,
    attendantName: value.attendance?.attendant?.attributes?.name,
    authorName: value.author.attributes?.name,
  };
}
