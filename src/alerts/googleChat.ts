import { env } from "../config/env.js";
import { logger } from "../logger.js";
import type { MessageEvent } from "../poli/parser.js";

/** Alerta pro gestor quando o time de pré-vendas fala com um número fora do HubSpot. */
export async function sendLeadNotInHubSpotAlert(message: MessageEvent): Promise<void> {
  if (!env.GOOGLE_CHAT_WEBHOOK_URL) {
    logger.warn({ leadPhone: message.leadPhone }, "GOOGLE_CHAT_WEBHOOK_URL não configurado, alerta não enviado");
    return;
  }

  const text = [
    "⚠️ *SDR falando com contato fora do HubSpot*",
    `Lead: ${message.leadName ?? "(sem nome)"} — ${message.leadPhone}`,
    `Atendente: ${message.attendantName ?? message.attendantEmail ?? "desconhecido"}`,
    `Direção: ${message.direction === "IN" ? "lead escreveu" : "time escreveu"}`,
  ].join("\n");

  const res = await fetch(env.GOOGLE_CHAT_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });

  if (!res.ok) {
    logger.error({ status: res.status }, "Falha ao enviar alerta pro Google Chat");
  }
}
