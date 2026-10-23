import { describe, expect, it } from "vitest";
import { poliWebhookBodySchema } from "../src/poli/types.js";
import { parseMessageEvent } from "../src/poli/parser.js";
import received from "./fixtures/received.json" with { type: "json" };
import sent from "./fixtures/sent.json" with { type: "json" };
import receivedNullStatus from "./fixtures/received-null-attendance-status.json" with { type: "json" };
import sentTemplateNullCategory from "./fixtures/sent-template-null-category.json" with { type: "json" };
import sentComponentsNull from "./fixtures/sent-components-null.json" with { type: "json" };
import sentContatoSemTelefone from "./fixtures/sent-contato-sem-telefone.json" with { type: "json" };
import sentMediaString from "./fixtures/sent-media-string.json" with { type: "json" };

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

  it("descreve anexos de mídia (formato da documentação da Poli)", () => {
    const body = structuredClone(received) as Record<string, any>;
    body.value.type = "MEDIA";
    body.value.components = {
      attachments: [{ type: "IMAGE", media: { uploaded: true, caption: "Foto do cardápio", url: "https://cdn.poli/x.jpg" } }],
    };
    const message = parseMessageEvent(poliWebhookBodySchema.parse(body));

    expect(message.text).toBe("");
    expect(message.mediaDescription).toBe("[Imagem] Foto do cardápio (https://cdn.poli/x.jpg)");
  });

  it("usa o tipo da mensagem quando não há texto nem anexo", () => {
    const body = structuredClone(received) as Record<string, any>;
    body.value.type = "LOCATION";
    body.value.components = {};
    const message = parseMessageEvent(poliWebhookBodySchema.parse(body));

    expect(message.mediaDescription).toBe("[Localização]");
  });

  // Os três casos abaixo vinham de eventos reais que ficaram presos na fila
  // de falhas entre 21/09 e 01/10 por não passarem no schema.
  it("aceita components null (mensagem de template)", () => {
    const message = parseMessageEvent(poliWebhookBodySchema.parse(sentComponentsNull));

    expect(message.text).toBe("");
    expect(message.attachments).toEqual([]);
  });

  it("aceita contato sem telefone", () => {
    const message = parseMessageEvent(poliWebhookBodySchema.parse(sentContatoSemTelefone));

    expect(message.leadPhone).toBe("");
    expect(message.leadUuid).toBeTruthy();
  });

  it("aceita anexo com media em texto no lugar do objeto", () => {
    const message = parseMessageEvent(poliWebhookBodySchema.parse(sentMediaString));

    expect(message.attachments[0]).toMatchObject({
      type: "IMAGE",
      url: "https://cdn.poli.digital/accounts/acc/messages/x-image.png",
    });
    expect(message.mediaDescription).toContain("[Imagem]");
  });
});
