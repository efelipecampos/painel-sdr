import pino from "pino";
import { env } from "./config/env.js";

/** LGPD (regra do projeto): telefone de lead nunca vai inteiro para o log; fica só o final, para achar o caso. */
export function mascararTelefone(valor: unknown): string {
  const d = String(valor ?? "").replace(/\D+/g, "");
  return d ? `***${d.slice(-4)}` : "";
}

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: { paths: ["leadPhone", "rawPhone", "phone", "*.leadPhone", "*.rawPhone", "*.phone"], censor: mascararTelefone },
  transport:
    process.env.NODE_ENV === "production"
      ? undefined
      : { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:standard" } },
});
