import { env } from "../config/env.js";
import { logger } from "../logger.js";
import type { MessageEvent } from "../poli/parser.js";
import type { AttendantRole } from "../config/team.js";

export function poliChatUrl(contactUuid: string): string {
  return `https://app.poli.digital/chat/${contactUuid}`;
}

function webhookUrlForRole(role: AttendantRole): string {
  return role === "SDR" ? env.GOOGLE_CHAT_WEBHOOK_URL_SDR : env.GOOGLE_CHAT_WEBHOOK_URL_CLOSER;
}

async function postToGoogleChat(role: AttendantRole, text: string): Promise<void> {
  const url = webhookUrlForRole(role);
  if (!url) {
    logger.warn({ role }, "URL do Google Chat pra esse papel não configurada, alerta não enviado");
    return;
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });

  if (!res.ok) {
    logger.error({ status: res.status, role }, "Falha ao enviar mensagem pro Google Chat");
  }
}

/**
 * Alerta pro gestor quando o time de pré-vendas fala com um número fora do
 * HubSpot. Vai pro espaço do Google Chat do papel de quem está atendendo
 * (SDR ou Closer) — são espaços separados porque "closer sem negócio" é
 * uma exceção mais grave no processo do que "SDR sem lead".
 */
export async function sendLeadNotInHubSpotAlert(message: MessageEvent, role: AttendantRole): Promise<void> {
  const text = [
    `⚠️ *${role} falando com contato fora do HubSpot*`,
    `Lead: ${message.leadName ?? "(sem nome)"} — ${message.leadPhone}`,
    `Atendente: ${message.attendantName ?? message.attendantEmail ?? "desconhecido"}`,
    `Direção: ${message.direction === "IN" ? "lead escreveu" : "time escreveu"}`,
    `<${poliChatUrl(message.leadUuid)}|Abrir chat na Poli>`,
  ].join("\n");

  await postToGoogleChat(role, text);
}

/** Alerta técnico da própria integração (ex.: muitas recusas no webhook). Sem URL configurada, só fica no log. */
export async function postOpsAlert(text: string): Promise<void> {
  const url = env.GOOGLE_CHAT_WEBHOOK_URL_OPS;
  if (!url) return;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });

  if (!res.ok) {
    logger.error({ status: res.status }, "Falha ao enviar alerta técnico pro Google Chat");
  }
}

export interface NotFoundContactSummary {
  leadName?: string;
  leadPhone: string;
  leadUuid: string;
}

/** Mensagem de teste/relatório manual com os últimos N contatos não encontrados, pro espaço de um papel específico. */
export async function sendNotFoundContactsReport(role: AttendantRole, contacts: NotFoundContactSummary[]): Promise<void> {
  const lines = [
    `🧪 *Teste: últimos ${contacts.length} contatos fora do HubSpot (${role})*`,
    "",
    ...contacts.map(
      (c, i) =>
        `${i + 1}. ${c.leadName ?? "(sem nome)"} — ${c.leadPhone}\n<${poliChatUrl(c.leadUuid)}|Abrir chat na Poli>`,
    ),
  ];

  await postToGoogleChat(role, lines.join("\n"));
}
