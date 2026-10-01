import { supabaseFetch } from "./client.js";
import { isProspectingOpener } from "../config/prospectingTemplates.js";
import { getAttendantRole } from "../config/team.js";
import type { MessageEvent } from "../poli/parser.js";

/**
 * Espelho de todas as mensagens no Supabase — base do painel de análise, já
 * que o HubSpot não deixa usar registros de mensagem em relatório. Guarda
 * tudo que o webhook entrega, inclusive mensagens fora da pré-venda, com o
 * resultado do processamento pra dar pra cruzar com o CRM.
 */

export interface MessageRow {
  /** Nulo no backfill do histórico, que só tem o id da Communication. */
  external_message_id: string | null;
  poli_message_uuid: string | null;
  direction: "IN" | "OUT";
  sent_at: string;
  text: string | null;
  media_description: string | null;
  is_template: boolean;
  template_name: string | null;
  is_prospecting_opener: boolean;
  lead_phone: string | null;
  lead_name: string | null;
  lead_uuid: string | null;
  deprecated_contact_id: string | null;
  attendant_email: string | null;
  attendant_name: string | null;
  attendant_role: string | null;
  author_name: string | null;
  hubspot_contact_id: string | null;
  hubspot_communication_id: string | null;
  hubspot_deal_ids: string[] | null;
  outcome: string | null;
}

export interface MessageOutcome {
  outcome: string;
  contactId?: string | null;
  communicationId?: string | null;
  dealIds?: string[];
}

export function buildMessageRow(message: MessageEvent, result: MessageOutcome): MessageRow {
  return {
    external_message_id: message.externalMessageId,
    poli_message_uuid: message.poliMessageUuid ?? null,
    direction: message.direction,
    sent_at: new Date(message.timestampMs).toISOString(),
    text: message.text || null,
    media_description: message.mediaDescription ?? null,
    is_template: message.isTemplate,
    template_name: message.templateName ?? null,
    is_prospecting_opener: message.isTemplate && isProspectingOpener(message.templateName),
    lead_phone: message.leadPhone,
    lead_name: message.leadName ?? null,
    lead_uuid: message.leadUuid ?? null,
    deprecated_contact_id: message.deprecatedContactId ?? null,
    attendant_email: message.attendantEmail ?? null,
    attendant_name: message.attendantName ?? null,
    attendant_role: getAttendantRole(message.attendantEmail) ?? null,
    author_name: message.authorName ?? null,
    hubspot_contact_id: result.contactId ?? null,
    hubspot_communication_id: result.communicationId ?? null,
    hubspot_deal_ids: result.dealIds ?? null,
    outcome: result.outcome,
  };
}

export async function upsertMessages(rows: MessageRow[], onConflict = "external_message_id"): Promise<void> {
  if (rows.length === 0) return;
  await supabaseFetch(`/messages?on_conflict=${onConflict}`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(rows),
  });
}

export interface DayMessage {
  sent_at: string;
  direction: "IN" | "OUT";
  text: string | null;
  media_description: string | null;
  template_name: string | null;
  attendant_name: string | null;
  lead_name: string | null;
  hubspot_contact_id: string;
}

/**
 * Mensagens de um intervalo que têm contato resolvido no HubSpot — usado pra
 * montar a nota diária por contato.
 */
export async function listMessagesBetween(fromIso: string, toIso: string): Promise<DayMessage[]> {
  const columns = "sent_at,direction,text,media_description,template_name,attendant_name,lead_name,hubspot_contact_id";
  const query = [
    `select=${columns}`,
    `sent_at=gte.${fromIso}`,
    `sent_at=lt.${toIso}`,
    "hubspot_contact_id=not.is.null",
    "order=sent_at.asc",
    "limit=50000",
  ].join("&");
  return supabaseFetch<DayMessage[]>(`/messages?${query}`);
}

/** Atualiza só o texto de uma mensagem já gravada (retry da mídia). */
export async function updateMessageText(externalMessageId: string, text: string): Promise<void> {
  await supabaseFetch(`/messages?external_message_id=eq.${encodeURIComponent(externalMessageId)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ text }),
  });
}
