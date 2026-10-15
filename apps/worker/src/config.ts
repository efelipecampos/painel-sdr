// Configuração do worker. Em desenvolvimento lê o .env da raiz do repositório;
// em produção as variáveis vêm do docker compose.
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const rootEnv = resolve(import.meta.dirname, "../../../.env");
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Variável de ambiente ${name} não definida.`);
  return v;
}

function emailList(name: string): Set<string> {
  return new Set((process.env[name] ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean));
}

export type TeamRole = "sdr" | "closer" | "gestor";

import { parseTimes } from "./score/schedule.js";

export const config = {
  supabaseUrl: required("NEXT_PUBLIC_SUPABASE_URL"),
  serviceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
  sdrEmails: emailList("POLI_SDR_EMAILS"),
  closerEmails: emailList("POLI_CLOSER_EMAILS"),
  managerEmails: emailList("POLI_MANAGER_EMAILS"),
  /** Atendentes que são robôs da Poli (ex.: Lia): mensagens deles não contam como resposta humana. */
  botEmails: emailList("POLI_BOT_EMAILS"),
  /** Intervalo entre rodadas de leitura de raw_events. */
  pollSeconds: Number(process.env.WORKER_POLL_SECONDS ?? 30),
  /** Eventos por lote. */
  batchSize: Number(process.env.WORKER_BATCH_SIZE ?? 500),
  /** Token do app privado do HubSpot (só leitura). Sem ele, o sync do HubSpot não roda. */
  hubspotToken: process.env.HUBSPOT_PRIVATE_APP_TOKEN?.trim() || null,
  /** Intervalo do sync de Leads do HubSpot. */
  hubspotEveryMinutes: Number(process.env.HUBSPOT_SYNC_MINUTES ?? 15),
  /** Horários das rodadas do score (fuso de São Paulo) e máximo de leads por rodada (controle de custo). */
  scoreTimes: parseTimes(process.env.SCORE_HORARIOS),
  scoreMaxPerRound: Number(process.env.SCORE_MAX_POR_RODADA ?? 300),
  /** Score: 0 = avisa já na rodada diária que falhar. */
  alertScoreMinutes: Number(process.env.ALERTA_SCORE_MIN ?? 0),
  /** Webhook do espaço Gestão SDR no Google Chat. Sem ele, os alertas só vão para o log. */
  alertWebhookUrl: process.env.GOOGLE_CHAT_WEBHOOK_URL_ALERTAS?.trim() || null,
  /** Endereço do painel, para conferir se está no ar. */
  painelUrl: (process.env.PAINEL_URL?.trim() || "https://painel-sdr.camposai.com.br").replace(/\/$/, ""),
  /** Intervalo das verificações de saúde (fila, Poli, painel no ar). */
  alertCheckMinutes: Number(process.env.ALERTA_INTERVALO_MIN ?? 2),
  /** Fila parada: evento esperando há este tempo sem o worker processar. */
  alertQueueMinutes: Number(process.env.ALERTA_FILA_MIN ?? 10),
  /** Integração muda: este tempo, em horário comercial, sem evento novo da Poli. */
  alertPoliMinutes: Number(process.env.ALERTA_POLI_MIN ?? 30),
  /** Worker com erro em todas as rodadas por este tempo. */
  alertWorkerMinutes: Number(process.env.ALERTA_WORKER_MIN ?? 5),
  /** Sync do HubSpot falhando por este tempo. */
  alertHubspotMinutes: Number(process.env.ALERTA_HUBSPOT_MIN ?? 30),
  /** Painel sem responder por este tempo. */
  alertPainelMinutes: Number(process.env.ALERTA_PAINEL_MIN ?? 5),
  /** Google Agenda (Fase 10c). Sem as três variáveis, a conferência das agendas não roda. */
  google: process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_TOKEN_KEY
    ? {
        clientId: process.env.GOOGLE_CLIENT_ID.trim(),
        clientSecret: process.env.GOOGLE_CLIENT_SECRET.trim(),
        redirectUri: `https://${process.env.APP_DOMAIN?.trim() || "painel-sdr.camposai.com.br"}/api/google/callback`,
        tokenKey: process.env.GOOGLE_TOKEN_KEY.trim(),
      }
    : null,
  /** Intervalo da conferência das agendas e dos eventos. */
  googleEveryMinutes: Number(process.env.GOOGLE_CHECK_MINUTES ?? 10),
  /**
   * API do Poli (Fase 11, jornada configurável). Sem endereço e token, a jornada não roda.
   * Conta e Canal Principal: os mesmos das aberturas da automação (vistos nos eventos em 2026-10-15).
   */
  poli: process.env.POLI_API_BASE_URL?.trim() && process.env.POLI_API_TOKEN?.trim()
    ? {
        baseUrl: process.env.POLI_API_BASE_URL.trim(),
        token: process.env.POLI_API_TOKEN.trim(),
        accountUuid: process.env.POLI_ACCOUNT_UUID?.trim() || "9b8af98e-0407-49a2-bce9-3620f29c513a",
        channelUuid: process.env.POLI_CHANNEL_UUID?.trim() || "9b8bae9e-2fe2-4f2a-82a2-abb931c7d7ce",
        templatesEveryMinutes: Number(process.env.JORNADA_TEMPLATES_MIN ?? 30),
      }
    : null,
};

export function isBot(email: string | null): boolean {
  return !!email && config.botEmails.has(email);
}

export function roleFor(email: string | null): TeamRole | null {
  if (!email || isBot(email)) return null;
  if (config.sdrEmails.has(email)) return "sdr";
  if (config.closerEmails.has(email)) return "closer";
  if (config.managerEmails.has(email)) return "gestor";
  return null;
}
