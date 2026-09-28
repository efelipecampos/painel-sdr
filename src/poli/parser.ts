import type { PoliWebhookBody } from "./types.js";

export interface MessageEvent {
  /** Chave de dedupe: wamid do WhatsApp quando disponível, senão o uuid da mensagem. */
  externalMessageId: string;
  /** uuid da mensagem na Poli (value.uuid) — chave estável do lado deles. */
  poliMessageUuid: string;
  direction: "IN" | "OUT";
  timestampMs: number;
  text: string;
  /** Descrição de mídia/tipo quando a mensagem não é só texto (ex.: "[Áudio]"). */
  mediaDescription?: string;
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

const ATTACHMENT_LABELS: Record<string, string> = {
  AUDIO: "Áudio",
  VOICE: "Áudio",
  PTT: "Áudio",
  IMAGE: "Imagem",
  VIDEO: "Vídeo",
  DOCUMENT: "Documento",
  FILE: "Documento",
  STICKER: "Figurinha",
};

const MESSAGE_TYPE_LABELS: Record<string, string> = {
  ...ATTACHMENT_LABELS,
  LOCATION: "Localização",
  CONTACT: "Contato",
  VCARD: "Contato",
  MEDIA: "Mídia",
};

function label(type: string | null | undefined, table: Record<string, string>, fallback: string): string {
  const key = (type ?? "").toUpperCase();
  return table[key] ?? (key ? key.charAt(0) + key.slice(1).toLowerCase() : fallback);
}

/**
 * Descreve anexos (ou o tipo da mensagem, se não for texto) pra mensagem não
 * virar um registro vazio no HubSpot — ex.: "[Imagem] legenda (url)".
 */
export function describeMedia(value: PoliWebhookBody["value"]): string | undefined {
  const parts = (value.components.attachments ?? []).map((a) => {
    const media = a.media ?? {};
    const detail = [media.caption, media.filename ?? media.name].filter(Boolean).join(" — ");
    return [`[${label(a.type, ATTACHMENT_LABELS, "Anexo")}]`, detail, media.url ? `(${media.url})` : ""]
      .filter(Boolean)
      .join(" ");
  });
  if (parts.length > 0) return parts.join("\n");

  const type = (value.type ?? "").toUpperCase();
  if (type && type !== "CHAT" && type !== "TEXT") return `[${label(type, MESSAGE_TYPE_LABELS, "Mensagem")}]`;
  return undefined;
}

export function parseMessageEvent(body: PoliWebhookBody): MessageEvent {
  const { value } = body;

  return {
    externalMessageId: value.metadata.external_message_id ?? value.uuid,
    poliMessageUuid: value.uuid,
    direction: value.direction,
    timestampMs: value.timestamp * 1000,
    text: value.components.body?.text ?? "",
    mediaDescription: describeMedia(value),
    leadPhone: value.contact.attributes.phone,
    leadName: value.contact.attributes.name ?? undefined,
    leadUuid: value.contact.uuid,
    attendantEmail: value.attendance?.attendant?.email ?? undefined,
    attendantName: value.attendance?.attendant?.attributes?.name ?? undefined,
    authorName: value.author.attributes?.name ?? undefined,
    isTemplate: value.template != null,
    templateName: value.template?.key ?? value.template?.name ?? undefined,
    deprecatedContactId:
      value.metadata.deprecated_contact_id != null ? String(value.metadata.deprecated_contact_id) : undefined,
  };
}
