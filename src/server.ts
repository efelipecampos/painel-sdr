import express, { type Request } from "express";
import { pinoHttp } from "pino-http";
import { env } from "./config/env.js";
import { logger } from "./logger.js";
import { verifyPoliSignature } from "./poli/webhookAuth.js";
import { poliWebhookBodySchema } from "./poli/types.js";
import { parseMessageEvent } from "./poli/parser.js";
import { processMessage } from "./pipeline/processMessage.js";
import { isAlreadyProcessed, markProcessed, recordFailure, clearFailure, listFailedJobs } from "./queue/store.js";

interface RequestWithRawBody extends Request {
  rawBody?: Buffer;
}

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

// A Poli está configurada (no painel deles) pra entregar na raiz "/" — o
// alias "/webhooks/poli" fica mantido por clareza/documentação, caso o
// painel seja reconfigurado depois.
const webhookHandler = async (req: RequestWithRawBody, res: express.Response) => {
  const signatureValid = verifyPoliSignature(req.rawBody ?? Buffer.from(""), req.headers["x-webhook-signature"] as string | undefined);
  if (!signatureValid) {
    req.log.warn("Assinatura do webhook inválida, rejeitando");
    return res.status(401).json({ error: "invalid_signature" });
  }

  // Eventos que não são de mensagem (ex.: contacts.contact.updated) ainda
  // não têm handler — loga o corpo bruto pra investigação e confirma
  // recebido, pra Poli não ficar reentregando à toa.
  const rawObjectType = (req.body as { object?: unknown } | undefined)?.object;
  if (rawObjectType !== "message") {
    req.log.info({ event: req.headers["x-webhook-event"], object: rawObjectType, body: req.body }, "Evento não-mensagem recebido, ainda sem handler");
    return res.status(200).json({ received: true, handled: false });
  }

  // Só mensagens novas (recebida/enviada) viram Communication. Os demais
  // eventos de mensagem (ACK de entrega/leitura, atualização) têm outro
  // formato e são muito frequentes — confirma recebido sem logar, pra não
  // virar 400 e reentrega em massa do lado da Poli.
  const rawEvent = (req.body as { event?: unknown }).event;
  if (rawEvent !== "received" && rawEvent !== "sent") {
    return res.status(200).json({ received: true, handled: false });
  }
  // Mensagens de sistema da Poli (direction "SYSTEM", ex.: transferência de
  // atendimento) não são conversa com o lead.
  const rawDirection = (req.body as { value?: { direction?: unknown } }).value?.direction;
  if (rawDirection !== "IN" && rawDirection !== "OUT") {
    return res.status(200).json({ received: true, handled: false });
  }

  // Payload fora do formato esperado responde 200 mesmo assim (reentregar o
  // mesmo corpo falharia igual, e 400 só gera erro/retry na Poli), mas vai
  // pra fila de falhas — depois de ajustar o schema, o retry reprocessa.
  const parsedBody = poliWebhookBodySchema.safeParse(req.body);
  if (!parsedBody.success) {
    const rawValue = (req.body as { uuid?: string; value?: { uuid?: string; metadata?: { external_message_id?: string } } }).value;
    const fallbackId = rawValue?.metadata?.external_message_id ?? rawValue?.uuid ?? (req.body as { uuid?: string }).uuid;
    req.log.warn({ event: rawEvent, issues: parsedBody.error.issues, body: req.body }, "Payload da Poli não bateu com o schema esperado");
    if (fallbackId) {
      recordFailure(fallbackId, req.body, `invalid_payload: ${JSON.stringify(parsedBody.error.issues).slice(0, 500)}`);
    }
    return res.status(200).json({ received: true, handled: false, error: "invalid_payload" });
  }

  const message = parseMessageEvent(parsedBody.data);

  // Formato de mídia ainda não validado contra eventos reais — registra o
  // shape das mensagens sem texto pra conferir/ajustar describeMedia.
  if (!message.text) {
    req.log.info(
      { type: parsedBody.data.value.type, components: parsedBody.data.value.components, described: message.mediaDescription },
      "Mensagem sem texto recebida",
    );
  }

  req.log.debug(
    { contactAttributeKeys: Object.keys(parsedBody.data.value.contact.attributes), metadata: parsedBody.data.value.metadata },
    "Campos disponíveis em value.contact.attributes / value.metadata",
  );

  // Responde rápido e sempre 2xx pra Poli não ficar reentregando, mesmo que
  // o processamento em si falhe (falhas viram retry na fila local).
  res.status(200).json({ received: true });

  if (isAlreadyProcessed(message.externalMessageId)) {
    req.log.debug({ id: message.externalMessageId }, "Mensagem já processada, ignorando reentrega");
    return;
  }

  try {
    await processMessage(message);
    markProcessed(message.externalMessageId);
    clearFailure(message.externalMessageId);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    req.log.error({ err, id: message.externalMessageId }, "Falha ao processar mensagem, agendando retry");
    recordFailure(message.externalMessageId, parsedBody.data, errorMessage);
  }
};

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

app.listen(env.PORT, () => {
  logger.info(`Serviço PoliChat -> HubSpot rodando na porta ${env.PORT}`);
});
