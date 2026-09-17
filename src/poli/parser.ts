import type { PoliWebhookBody } from "./types.js";

export interface MessageEvent {
  /** Chave de dedupe: wamid do WhatsApp quando disponível, senão o uuid da mensagem. */
  externalMessageId: string;
  direction: "IN" | "OUT";
  timestampMs: number;
  text: string;
  leadPhone: string;
  leadName?: string;
  /** contact.uuid da Poli — usado pra montar o link direto do chat (app.poli.digital/chat/{uuid}). */
  leadUuid: string;
  /** E-mail de quem está atendendo a conversa na Poli, IN ou OUT — é o campo usado pro filtro de equipe. */
  attendantEmail?: string;
  attendantName?: string;
  /** Nome de quem efetivamente mandou essa mensagem (lead ou atendente). */
  authorName?: string;
  /** true quando a própria mensagem é um envio de template (value.template != null). */
  isTemplate: boolean;
  templateName?: string;
  /** ID numérico legado (value.metadata.deprecated_contact_id), como string. */
  deprecatedContactId?: string;
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
    leadUuid: value.contact.uuid,
    attendantEmail: value.attendance?.attendant?.email,
    attendantName: value.attendance?.attendant?.attributes?.name,
    authorName: value.author.attributes?.name,
    isTemplate: value.template != null,
    templateName: value.template?.name,
    deprecatedContactId:
      value.metadata.deprecated_contact_id != null ? String(value.metadata.deprecated_contact_id) : undefined,
  };
}
