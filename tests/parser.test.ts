import { describe, expect, it } from "vitest";
import { poliWebhookBodySchema } from "../src/poli/types.js";
import { parseMessageEvent } from "../src/poli/parser.js";
import received from "./fixtures/received.json" with { type: "json" };
import sent from "./fixtures/sent.json" with { type: "json" };

describe("parseMessageEvent com payloads reais da Poli", () => {
  it("interpreta uma mensagem recebida do lead (IN)", () => {
    const body = poliWebhookBodySchema.parse(received);
    const message = parseMessageEvent(body);

    expect(message.direction).toBe("IN");
    expect(message.leadPhone).toBe("5516997220323");
    expect(message.text).toBe("Vamos marcar");
    expect(message.attendantEmail).toBe("julliana.reis@poli.digital");
    expect(message.externalMessageId).toMatch(/^wamid\./);
    expect(message.timestampMs).toBe(1789582847 * 1000);
  });

  it("interpreta uma mensagem enviada pelo time (OUT)", () => {
    const body = poliWebhookBodySchema.parse(sent);
    const message = parseMessageEvent(body);

    expect(message.direction).toBe("OUT");
    expect(message.leadPhone).toBe("5519991211005");
    expect(message.attendantEmail).toBe("felipe.mendes@poli.digital");
    expect(message.authorName).toBe("Felipe Mendes");
  });
});
