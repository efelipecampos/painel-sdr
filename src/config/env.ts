import "dotenv/config";
import { z } from "zod";

// z.coerce.boolean() usa Boolean(valor) por baixo dos panos, então a string
// "false" vira `true` (é truthy em JS). Este helper trata "true"/"false"
// explicitamente.
const booleanFromEnv = (defaultValue: boolean) =>
  z.preprocess((val) => {
    if (typeof val !== "string") return val;
    if (val.toLowerCase() === "true") return true;
    if (val.toLowerCase() === "false") return false;
    return val;
  }, z.boolean().default(defaultValue));

const schema = z.object({
  PORT: z.coerce.number().default(3000),

  POLI_WEBHOOK_SIGNING_SECRET: z.string().optional().default(""),
  POLI_WEBHOOK_VERIFY_SIGNATURE: booleanFromEnv(true),
  POLI_SDR_CLOSER_EMAILS: z.string().optional().default(""),

  HUBSPOT_PRIVATE_APP_TOKEN: z.string().min(1, "HUBSPOT_PRIVATE_APP_TOKEN é obrigatório"),
  HUBSPOT_PORTAL_ID: z.string().optional(),

  GOOGLE_CHAT_WEBHOOK_URL: z.string().url().optional().or(z.literal("")),

  SQLITE_PATH: z.string().default("./data/queue.sqlite"),

  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error("Configuração inválida:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
