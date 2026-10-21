import type { NextFunction, Request, Response } from "express";
import { env } from "./config/env.js";
import { logger } from "./logger.js";
import { postOpsAlert } from "./alerts/googleChat.js";

/**
 * Proteções na frente do webhook da Poli (Fase 8 do Painel SDR, revisão de
 * segurança). Tudo aqui roda antes de ler o corpo e antes da assinatura, então
 * requisição recusada nunca chega em raw_events nem no HubSpot.
 *
 * Regra dos logs de recusa: só motivo, IP e status — nunca corpo, telefone ou
 * texto de mensagem.
 */

export type RejectionReason = "rate_limited" | "unsupported_content_type" | "body_too_large" | "invalid_json" | "invalid_signature";

/**
 * IP real do remetente. O Traefik do Coolify descarta X-Forwarded-For vindo
 * de fora (não há trustedIPs configurado) e escreve o dele, então o primeiro
 * valor é o IP de quem conectou no proxy.
 */
export function clientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
  return first || req.socket?.remoteAddress || "unknown";
}

/** Janela fixa de 1 minuto por IP. Em memória: um só container, e reiniciar zera sem prejuízo. */
export function createRateLimiter(limitPerMinute: number, now: () => number = Date.now) {
  const WINDOW_MS = 60_000;
  const windows = new Map<string, { start: number; count: number }>();

  return function allow(ip: string): boolean {
    const t = now();
    // Limpa janelas vencidas de vez em quando pra o mapa não crescer sem fim.
    if (windows.size > 10_000) {
      for (const [key, w] of windows) if (t - w.start >= WINDOW_MS) windows.delete(key);
    }
    const w = windows.get(ip);
    if (!w || t - w.start >= WINDOW_MS) {
      windows.set(ip, { start: t, count: 1 });
      return true;
    }
    w.count += 1;
    return w.count <= limitPerMinute;
  };
}

/**
 * Conta recusas numa janela móvel e alerta quando passam do limite — muita
 * recusa pode ser ataque ou sinal de que o limite ficou baixo pro pico real.
 * Depois de alertar, espera a janela inteira antes de alertar de novo.
 */
export function createRejectionMonitor(
  threshold: number,
  windowMs: number,
  onAlert: (count: number, byReason: Record<string, number>) => void,
  now: () => number = Date.now,
) {
  let events: { at: number; reason: RejectionReason }[] = [];
  let lastAlertAt = -Infinity;

  return function record(reason: RejectionReason): void {
    const t = now();
    events.push({ at: t, reason });
    events = events.filter((e) => t - e.at < windowMs);
    if (events.length >= threshold && t - lastAlertAt >= windowMs) {
      lastAlertAt = t;
      const byReason: Record<string, number> = {};
      for (const e of events) byReason[e.reason] = (byReason[e.reason] ?? 0) + 1;
      onAlert(events.length, byReason);
    }
  };
}

const REJECTION_ALERT_WINDOW_MS = 10 * 60_000;

const recordRejection = createRejectionMonitor(
  env.WEBHOOK_REJECTION_ALERT_THRESHOLD,
  REJECTION_ALERT_WINDOW_MS,
  (count, byReason) => {
    logger.error({ count, byReason, windowMinutes: 10 }, "Muitas requisições recusadas no webhook da Poli");
    const reasons = Object.entries(byReason)
      .map(([reason, n]) => `${reason}: ${n}`)
      .join(", ");
    postOpsAlert(
      `🚨 *Webhook da Poli: ${count} requisições recusadas nos últimos 10 min*\n${reasons}\n` +
        `Se for rate_limited vindo da própria Poli, o limite (WEBHOOK_RATE_LIMIT_PER_MINUTE=${env.WEBHOOK_RATE_LIMIT_PER_MINUTE}) pode estar baixo.`,
    ).catch((err) => logger.error({ err }, "Falha ao enviar alerta de recusas"));
  },
);

/** Registra a recusa sem conteúdo nenhum da requisição. */
export function logRejection(req: Request, reason: RejectionReason, status: number): void {
  logger.warn({ reason, status, ip: clientIp(req), path: req.path }, "Requisição ao webhook recusada");
  recordRejection(reason);
}

const allowRequest = createRateLimiter(env.WEBHOOK_RATE_LIMIT_PER_MINUTE);

export function rateLimitGuard(req: Request, res: Response, next: NextFunction) {
  if (allowRequest(clientIp(req))) return next();
  logRejection(req, "rate_limited", 429);
  res.status(429).set("Retry-After", "60").json({ error: "rate_limited" });
}

export function contentTypeGuard(req: Request, res: Response, next: NextFunction) {
  if (req.is("application/json")) return next();
  logRejection(req, "unsupported_content_type", 415);
  res.status(415).json({ error: "unsupported_content_type" });
}

/**
 * Erros do express.json: corpo grande demais (413) ou JSON quebrado (400).
 * Tratado aqui porque a mensagem de erro do JSON.parse traz um trecho do
 * corpo, e o handler padrão do Express jogaria isso no log.
 */
export function bodyErrorGuard(err: unknown, req: Request, res: Response, next: NextFunction) {
  const type = (err as { type?: string } | undefined)?.type;
  if (type === "entity.too.large") {
    logRejection(req, "body_too_large", 413);
    return res.status(413).json({ error: "body_too_large" });
  }
  if (type === "entity.parse.failed") {
    logRejection(req, "invalid_json", 400);
    return res.status(400).json({ error: "invalid_json" });
  }
  next(err);
}
