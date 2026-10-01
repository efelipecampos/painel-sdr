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
  POLI_SDR_EMAILS: z.string().optional().default(""),
  POLI_CLOSER_EMAILS: z.string().optional().default(""),

  HUBSPOT_PRIVATE_APP_TOKEN: z.string().min(1, "HUBSPOT_PRIVATE_APP_TOKEN é obrigatório"),
  HUBSPOT_PORTAL_ID: z.string().optional(),

  // Quando true, faz a busca de contato no HubSpot (e o alerta do Google
  // Chat quando não encontra) normalmente, mas NÃO cria Communication nem
  // atualiza propriedades do contato — só registra o resultado em
  // dry_run_results pra conferência antes de ligar a escrita de verdade.
  DRY_RUN: booleanFromEnv(false),

  GOOGLE_CHAT_WEBHOOK_URL_SDR: z.string().url().or(z.literal("")).default(""),
  GOOGLE_CHAT_WEBHOOK_URL_CLOSER: z.string().url().or(z.literal("")).default(""),

  // Espelho das mensagens pro painel de análise e base da nota diária.
  // Vazio = integração roda normalmente, só sem Supabase e sem nota diária.
  // Eventos crus da Poli pro painel de SDR (tabela raw_events).
  RAW_EVENTS_ENABLED: booleanFromEnv(true),
  // Mensagem enviada com template e sem uuid de autor é disparo do bot pelo
  // app token — único sinal disponível no payload (não há campo de app/token).
  POLI_APP_TOKEN_AUTHORLESS_TEMPLATES: booleanFromEnv(false),

  SUPABASE_URL: z.string().url().or(z.literal("")).default(""),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional().default(""),
  DAILY_NOTES_ENABLED: booleanFromEnv(true),

  // --- OpenAI: transcrição de áudio e leitura de imagem (só pro Supabase) ---
  OPENAI_API_KEY: z.string().optional().default(""),
  MEDIA_UNDERSTANDING_ENABLED: booleanFromEnv(true),
  // Só transcreve/lê mídia de chat da pré-venda — o espelho em `messages`
  // pega todos os times, e pagar pela mídia deles não traz nada pro painel.
  MEDIA_ONLY_PRESALES: booleanFromEnv(true),
  // "low" não mudou a contagem de tokens nos modelos 5.4 (medido em
  // 2026-10-01), mas respondeu mais rápido. Mantido como padrão.
  OPENAI_IMAGE_DETAIL: z.enum(["low", "high", "auto"]).default("low"),
  // Nomes de modelo em env porque o catálogo da OpenAI muda com frequência.
  OPENAI_TRANSCRIPTION_MODEL: z.string().default("gpt-4o-mini-transcribe"),
  // Vazio = a OpenAI detecta o idioma (há leads em português e em espanhol).
  OPENAI_TRANSCRIPTION_LANGUAGE: z.string().optional().default(""),
  OPENAI_VISION_MODEL: z.string().default("gpt-5.4-nano"),
  OPENAI_TIMEOUT_MS: z.coerce.number().default(120_000),
  MEDIA_DOWNLOAD_TIMEOUT_MS: z.coerce.number().default(30_000),
  MEDIA_MAX_MB: z.coerce.number().default(20),

  SQLITE_PATH: z.string().default("./data/queue.sqlite"),

  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error("Configuração inválida:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
