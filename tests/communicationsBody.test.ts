import { describe, expect, it } from "vitest";
import { buildCommunicationBody } from "../src/hubspot/communications.js";
import type { MessageEvent } from "../src/poli/parser.js";

const base: MessageEvent = {
  externalMessageId: "wamid.123",
  direction: "IN",
  timestampMs: 1_700_000_000_000,
  text: "Vamos marcar",
  leadPhone: "5516997220323",
  leadUuid: "a21bb5bf-8b92-4bc3-859e-b48f130970f8",
  isTemplate: false,
};

describe("buildCommunicationBody", () => {
  it("prefixa com [Recebida] quando a direção é IN", () => {
    expect(buildCommunicationBody(base)).toBe("[Recebida] Vamos marcar");
  });

  it("prefixa com [Enviada] quando a direção é OUT, independente do atendente", () => {
    const outMessage: MessageEvent = { ...base, direction: "OUT", attendantName: "Felipe Mendes" };
    expect(buildCommunicationBody(outMessage)).toBe("[Enviada] Vamos marcar");
  });

  it("descreve mídia quando não há texto, em vez de registrar vazio", () => {
    const audio: MessageEvent = { ...base, text: "", mediaDescription: "[Áudio] (https://cdn.poli/a.ogg)" };
    expect(buildCommunicationBody(audio)).toBe("[Recebida] [Áudio] (https://cdn.poli/a.ogg)");
  });

  it("marca mensagem sem texto e sem mídia reconhecida", () => {
    expect(buildCommunicationBody({ ...base, text: "" })).toBe("[Recebida] (mensagem sem texto)");
  });
});
