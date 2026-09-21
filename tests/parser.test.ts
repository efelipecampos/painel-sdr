import { describe, expect, it } from "vitest";
import { poliWebhookBodySchema } from "../src/poli/types.js";
import { parseMessageEvent } from "../src/poli/parser.js";
import received from "./fixtures/received.json" with { type: "json" };
import sent from "./fixtures/sent.json" with { type: "json" };
import receivedNullStatus from "./fixtures/received-null-attendance-status.json" with { type: "json" };
import sentTemplateNullCategory from "./fixtures/sent-template-null-category.json" with { type: "json" };

describe("parseMessageEvent com payloads reais da Poli", () => {
  it("interpreta uma mensagem recebida do lead (IN)", () => {
    const body = poliWebhookBodySchema.parse(received);
    const message = parseMessageEvent(body);

    expect(message.direction).toBe("IN");
    expect(message.leadPhone).toBe("5516997220323");
    expect(message.text).toBe("Vamos marcar");
    expect(message.attendantEmail).toBe("julliana.reis@poli.digital");
    expect(message.leadUuid).toBe("a21bb5bf-8b92-4bc3-859e-b48f130970f8");
    expect(message.externalMessageId).toMatch(/^wamid\./);
    expect(message.timestampMs).toBe(1789582847 * 1000);
    expect(message.isTemplate).toBe(false);
    expect(message.deprecatedContactId).toBe("67912511");
  });

  it("interpreta uma mensagem enviada pelo time (OUT)", () => {
    const body = poliWebhookBodySchema.parse(sent);
    const message = parseMessageEvent(body);

    expect(message.direction).toBe("OUT");
    expect(message.leadPhone).toBe("5519991211005");
    expect(message.attendantEmail).toBe("felipe.mendes@poli.digital");
    expect(message.authorName).toBe("Felipe Mendes");
    expect(message.isTemplate).toBe(false);
  });

  it("marca isTemplate quando value.template vem preenchido", () => {
    const body = poliWebhookBodySchema.parse({
      ...sent,
      value: { ...sent.value, template: { name: "polichat_quick_message_488676", category: 12, language: 46 } },
    });
    const message = parseMessageEvent(body);

    expect(message.isTemplate).toBe(true);
    expect(message.templateName).toBe("polichat_quick_message_488676");
  });

  it("aceita attendance.status null (evento real que era rejeitado com 400)", () => {
    const message = parseMessageEvent(poliWebhookBodySchema.parse(receivedNullStatus));

    expect(message.direction).toBe("IN");
    expect(message.attendantEmail).toBe("atendente.a@poli.digital");
    expect(message.text).toBe("sim, mas eu já tentei");
  });

  it("aceita template com category null e usa template.key como nome", () => {
    const message = parseMessageEvent(poliWebhookBodySchema.parse(sentTemplateNullCategory));

    expect(message.direction).toBe("OUT");
    expect(message.isTemplate).toBe(true);
    expect(message.templateName).toBe("SDR_DIA01_NEW");
  });

  it("aceita mensagem automática sem author.uuid e sem atendente", () => {
    const body = structuredClone(sentTemplateNullCategory) as Record<string, any>;
    body.value.author = { type: "USER" };
    delete body.value.attendance;
    const message = parseMessageEvent(poliWebhookBodySchema.parse(body));

    expect(message.direction).toBe("OUT");
    expect(message.attendantEmail).toBeUndefined();
  });
});
