import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../config/env.js";
import { logger } from "../logger.js";

const MAX_TIMESTAMP_SKEW_SECONDS = 5 * 60;

/**
 * Valida o header `x-webhook-signature: t=<unix>,v1=<hmac-sha256 hex>`.
 *
 * A Poli não documenta publicamente o esquema de assinatura — o formato do
 * header segue o padrão comum (Stripe-like): HMAC-SHA256(secret,
 * `${timestamp}.${rawBody}`). PENDENTE: confirmar com o suporte/documentação
 * da Poli se é exatamente isso antes de habilitar em produção. Até lá, deixe
 * POLI_WEBHOOK_VERIFY_SIGNATURE=false no .env para não bloquear mensagens
 * legítimas por um esquema mal assumido.
 */
export function verifyPoliSignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
  if (!env.POLI_WEBHOOK_VERIFY_SIGNATURE) return true;

  if (!signatureHeader) {
    logger.warn("Webhook da Poli sem header x-webhook-signature");
    return false;
  }
  if (!env.POLI_WEBHOOK_SIGNING_SECRET) {
    logger.error("POLI_WEBHOOK_SIGNING_SECRET não configurado, mas verificação está habilitada");
    return false;
  }

  const parts = Object.fromEntries(
    signatureHeader.split(",").map((part) => {
      const [key, value] = part.split("=");
      return [key, value];
    }),
  );

  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature) {
    logger.warn({ signatureHeader }, "Header x-webhook-signature em formato inesperado");
    return false;
  }

  const skew = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(skew) || skew > MAX_TIMESTAMP_SKEW_SECONDS) {
    logger.warn({ timestamp, skew }, "Timestamp do webhook fora da janela aceita");
    return false;
  }

  const expected = createHmac("sha256", env.POLI_WEBHOOK_SIGNING_SECRET)
    .update(`${timestamp}.${rawBody.toString("utf8")}`)
    .digest("hex");

  const expectedBuf = Buffer.from(expected, "hex");
  const receivedBuf = Buffer.from(signature, "hex");
  if (expectedBuf.length !== receivedBuf.length) return false;

  return timingSafeEqual(expectedBuf, receivedBuf);
}
