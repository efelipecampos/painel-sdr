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
    email: z.string().email().optional(),
    attributes: z.object({ name: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();

const attendanceSchema = z
  .object({
    uuid: z.string(),
    status: z.string(),
    attendant: attendantSchema.optional(),
  })
  .passthrough();

const contactSchema = z
  .object({
    uuid: z.string(),
    attributes: z
      .object({
        name: z.string().optional(),
        phone: z.string(),
      })
      .passthrough(),
  })
  .passthrough();

const authorSchema = z
  .object({
    type: z.enum(["CONTACT", "USER"]),
    uuid: z.string(),
    attributes: z.object({ name: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();

const componentsSchema = z
  .object({
    body: z.object({ text: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();

const metadataSchema = z
  .object({
    external_message_id: z.string().optional(),
    direction: z.enum(["IN", "OUT"]).optional(),
    created_at: z.string().optional(),
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
    attendance: attendanceSchema.optional(),
    metadata: metadataSchema,
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
