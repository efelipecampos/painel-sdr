// Leitura de um evento cru da Poli (public.raw_events.payload) e classificação do remetente.
// Mapeamento aprovado em 2026-10-04 (docs/COMECE-AQUI.md, Decisões).
// Baseado em PoliChat-Hubspot/src/poli/types.ts, mas tolerante: aceita direction SYSTEM/EMPTY,
// que o schema da integração rejeita.

export type Sender = "lead" | "sdr" | "bot" | "template" | "system";
export type NoteTag = "finalizado" | "dsq" | "descartado";

export interface Attendant {
  uuid: string;
  email: string | null;
  name: string | null;
}

export interface PoliEvent {
  messageId: string;               // value.uuid (único por evento)
  externalMessageId: string;       // wamid do WhatsApp quando houver; liga com public.messages
  sentAt: Date;                    // value.timestamp
  attendanceUuid: string;
  attendanceStatus: string | null;
  attendanceType: string | null;
  closedReason: string | null;
  owner: Attendant | null;         // dono do chat no momento do evento
  contact: { uuid: string; name: string | null; phone: string | null };
  sender: Sender;
  byHuman: boolean;                // mensagem ou template enviado por uma pessoa da equipe
  authorUuid: string | null;
  direction: string;
  messageType: string | null;
  systemType: string | null;
  templateName: string | null;
  body: string | null;
  noteTag: NoteTag | null;         // marcação de descarte em nota interna (o texto da nota não é guardado)
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** Devolve null quando o payload não tem o mínimo para virar mensagem de um chat. */
export function parsePoliEvent(payload: unknown): PoliEvent | null {
  const value = obj(obj(payload)?.value);
  if (!value) return null;
  const messageId = str(value.uuid);
  const timestamp = typeof value.timestamp === "number" ? value.timestamp : null;
  const attendance = obj(value.attendance);
  const attendanceUuid = str(attendance?.uuid);
  const contact = obj(value.contact);
  const contactUuid = str(contact?.uuid);
  if (!messageId || timestamp === null || !attendanceUuid || !contactUuid) return null;

  const author = obj(value.author);
  const authorType = str(author?.type);
  const authorUuid = str(author?.uuid);
  const attendantRaw = obj(attendance?.attendant);
  const owner = str(attendantRaw?.uuid)
    ? {
        uuid: str(attendantRaw!.uuid)!,
        email: str(attendantRaw!.email)?.trim().toLowerCase() ?? null,
        name: str(obj(attendantRaw!.attributes)?.name),
      }
    : null;
  const template = obj(value.template);
  const templateName = str(template?.key) ?? str(template?.name);
  const direction = str(value.direction) ?? "";
  const messageType = str(value.type);
  const isSystem = direction === "SYSTEM" || direction === "EMPTY" || (str(value.event) ?? "MESSAGE") !== "MESSAGE";

  let sender: Sender;
  if (isSystem) sender = "system";
  else if (authorType === "CONTACT") sender = "lead";
  else if (template) sender = "template";
  else if (authorUuid) sender = "sdr";
  else sender = "bot";

  const contactAttrs = obj(contact?.attributes);
  return {
    messageId,
    externalMessageId: str(obj(value.metadata)?.external_message_id) ?? messageId,
    sentAt: new Date(timestamp * 1000),
    attendanceUuid,
    attendanceStatus: str(attendance?.status),
    attendanceType: str(attendance?.type),
    closedReason: str(attendance?.closed_reason),
    owner,
    contact: { uuid: contactUuid, name: str(contactAttrs?.name), phone: str(contactAttrs?.phone) },
    sender,
    byHuman: (sender === "sdr" || sender === "template") && authorUuid !== null && direction === "OUT",
    authorUuid,
    direction,
    messageType,
    systemType: isSystem ? messageType : null,
    templateName,
    noteTag: messageType === "NOTE" ? noteTagOf(str(obj(value.note)?.notes_body)) : null,
    // Nota interna, resumo e outros eventos de sistema não guardam texto.
    body: isSystem ? null : (str(obj(obj(value.components)?.body)?.text) ?? str(template?.message) ?? (messageType ? `[${messageType}]` : null)),
  };
}

/** Telefone no formato E.164 (+55...). Sem DDI, assume Brasil. */
export function toE164(phone: string | null): string | null {
  const digits = (phone ?? "").replace(/\D+/g, "");
  if (!digits) return null;
  if (digits.length <= 11) return `+55${digits}`;
  return `+${digits}`;
}

/**
 * Marcação de descarte numa nota interna da Poli (decisão de 2026-10-05):
 * "Finalizado" ou 0, "DSQ" ou 1, "Descartado" ou 2. Sem diferenciar maiúscula, minúscula ou acento.
 * O código numérico só vale quando a nota é só o número.
 */
export function noteTagOf(text: string | null): NoteTag | null {
  if (!text) return null;
  const t = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  if (t === "0") return "finalizado";
  if (t === "1") return "dsq";
  if (t === "2") return "descartado";
  if (/\bdescartado\b/.test(t)) return "descartado";
  if (/\bdsq\b/.test(t)) return "dsq";
  if (/\bfinalizado\b/.test(t)) return "finalizado";
  return null;
}
