import { z } from "zod";

/**
 * Schema do payload de webhook "mensagem" da PoliChat, baseado em exemplos
 * reais dos eventos messages.message.received / messages.message.sent.
 * .passthrough() em cada nível porque a Poli pode adicionar campos que não
 * usamos — só validamos o que a pipeline realmente lê.
 */

const attendantSchema = z
  .object({
    uuid: z.string(),
    email: z.string().nullish(),
    attributes: z.object({ name: z.string().nullish() }).passthrough().nullish(),
  })
  .passthrough();

const attendanceSchema = z
  .object({
    uuid: z.string(),
    // Vem null em eventos reais (ex.: atendimento iniciado pelo contato).
    status: z.string().nullish(),
    attendant: attendantSchema.nullish(),
  })
  .passthrough();

const contactSchema = z
  .object({
    uuid: z.string(),
    attributes: z
      .object({
        name: z.string().nullish(),
        phone: z.string(),
      })
      .passthrough(),
  })
  .passthrough();

const authorSchema = z
  .object({
    type: z.string(),
    uuid: z.string(),
    attributes: z.object({ name: z.string().nullish() }).passthrough().nullish(),
  })
  .passthrough();

const componentsSchema = z
  .object({
    body: z.object({ text: z.string().nullish() }).passthrough().nullish(),
  })
  .passthrough();

// Formato de exemplo visto em `context.message.components` (mensagem
// original de um clique de botão) — `value.template` provavelmente segue a
// mesma forma quando a própria mensagem é um envio de template. Ainda não
// validamos contra um evento real com `template` preenchido, então fica
// bem permissivo (.passthrough() + tudo opcional).
const templateSchema = z
  .object({
    // Em eventos reais o identificador do template vem em `key` (ex.:
    // "SDR_DIA01_NEW"), e category/goal podem vir null.
    key: z.string().nullish(),
    name: z.string().nullish(),
    category: z.union([z.string(), z.number()]).nullish(),
    language: z.union([z.string(), z.number()]).nullish(),
  })
  .passthrough();

const metadataSchema = z
  .object({
    external_message_id: z.string().nullish(),
    direction: z.enum(["IN", "OUT"]).nullish(),
    created_at: z.string().nullish(),
    // ID numérico legado do contato na Poli — usado hoje no HubSpot em
    // `id_do_contato_na_poli` pra ~49 mil contatos populados num bulk
    // histórico. Continua útil pra matching mesmo migrando o link pro
    // formato com UUID.
    deprecated_contact_id: z.union([z.number(), z.string()]).nullish(),
  })
  .passthrough();

const valueSchema = z
  .object({
    uuid: z.string(),
    direction: z.enum(["IN", "OUT"]),
    timestamp: z.number(),
    author: authorSchema,
    contact: contactSchema,
    components: componentsSchema,
    attendance: attendanceSchema.nullish(),
    metadata: metadataSchema,
    template: templateSchema.nullable().optional(),
  })
  .passthrough();

export const poliWebhookBodySchema = z
  .object({
    object: z.literal("message"),
    event: z.string(),
    account_uuid: z.string(),
    uuid: z.string(),
    value: valueSchema,
  })
  .passthrough();

export type PoliWebhookBody = z.infer<typeof poliWebhookBodySchema>;
