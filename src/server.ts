import express from "express";
import { pinoHttp } from "pino-http";
import { env } from "./config/env.js";
import { logger } from "./logger.js";
import { poliWebhookBodySchema } from "./poli/types.js";
import { parseMessageEvent } from "./poli/parser.js";
import { webhookHandler, type RequestWithRawBody } from "./webhookHandler.js";
import { processMessage } from "./pipeline/processMessage.js";
import { captureRawEvent } from "./pipeline/captureRawEvent.js";
import { runPendingDailyNotes } from "./jobs/dailyNotes.js";
import { extractMediaText, type MediaTarget } from "./media/mediaText.js";
import { updateMessageText } from "./supabase/messages.js";
import {
  markProcessed,
  recordFailure,
  clearFailure,
  listFailedJobs,
  listRawEventJobs,
  recordRawEventFailure,
  listMediaTextJobs,
  recordMediaTextFailure,
  clearMediaTextJob,
} from "./queue/store.js";

const app = express();
app.use(pinoHttp({ logger }));
app.use(
  express.json({
    verify: (req: RequestWithRawBody, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/", webhookHandler);
app.post("/webhooks/poli", webhookHandler);

const RETRY_INTERVAL_MS = 60_000;
const MAX_RETRY_ATTEMPTS = 10;

async function retryFailedJobs(): Promise<void> {
  const jobs = listFailedJobs(MAX_RETRY_ATTEMPTS);
  for (const job of jobs) {
    try {
      const body = poliWebhookBodySchema.parse(JSON.parse(job.payload));
      const message = parseMessageEvent(body);
      await processMessage(message);
      markProcessed(message.externalMessageId);
      clearFailure(message.externalMessageId);
      logger.info({ id: message.externalMessageId }, "Retry bem-sucedido");
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      recordFailure(job.external_message_id, JSON.parse(job.payload), errorMessage);
      logger.warn({ id: job.external_message_id, attempts: job.attempts }, "Retry falhou de novo");
    }
  }
}

setInterval(() => {
  retryFailedJobs().catch((err) => logger.error({ err }, "Erro no loop de retry"));
}, RETRY_INTERVAL_MS);

/** Retry dos eventos crus que não entraram no Supabase (painel de SDR). */
async function retryRawEventJobs(): Promise<void> {
  for (const job of listRawEventJobs(MAX_RETRY_ATTEMPTS)) {
    try {
      const result = await captureRawEvent(JSON.parse(job.payload), job.event_type ?? undefined);
      if (result.stored) logger.info({ externalId: job.external_id }, "Evento cru gravado no retry");
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      recordRawEventFailure(job.external_id, job.event_type ?? undefined, JSON.parse(job.payload), errorMessage);
    }
  }
}

setInterval(() => {
  retryRawEventJobs().catch((err) => logger.error({ err }, "Erro no loop de retry de eventos crus"));
}, RETRY_INTERVAL_MS);

/**
 * Retry do texto de mídia: a mensagem já está no Supabase sem texto, aqui só
 * tentamos de novo a transcrição/leitura e atualizamos a linha.
 */
async function retryMediaTextJobs(): Promise<void> {
  for (const job of listMediaTextJobs(MAX_RETRY_ATTEMPTS)) {
    const target = JSON.parse(job.target) as MediaTarget;
    try {
      const extracted = await extractMediaText(target);
      const text = [job.original_text, extracted].filter(Boolean).join("\n\n");
      await updateMessageText(job.external_message_id, text);
      clearMediaTextJob(job.external_message_id);
      logger.info({ id: job.external_message_id, kind: target.kind }, "Texto da mídia gravado no retry");
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      recordMediaTextFailure(job.external_message_id, target, job.original_text ?? "", errorMessage);
    }
  }
}

setInterval(() => {
  retryMediaTextJobs().catch((err) => logger.error({ err }, "Erro no loop de retry do texto de mídia"));
}, RETRY_INTERVAL_MS);

// Nota diária por contato (fonte pra IA do HubSpot): a cada hora verifica se
// o dia anterior já virou nota. Ver runPendingDailyNotes.
const DAILY_NOTES_INTERVAL_MS = 60 * 60_000;

if (env.DAILY_NOTES_ENABLED) {
  const tick = () =>
    runPendingDailyNotes().catch((err) => logger.error({ err }, "Erro no loop da nota diária"));
  setInterval(tick, DAILY_NOTES_INTERVAL_MS);
  tick();
}

app.listen(env.PORT, () => {
  logger.info(`Serviço PoliChat -> HubSpot rodando na porta ${env.PORT}`);
});
