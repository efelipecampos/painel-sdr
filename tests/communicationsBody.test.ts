import { describe, expect, it } from "vitest";
import { buildCommunicationBody } from "../src/hubspot/communications.js";
import type { MessageEvent } from "../src/poli/parser.js";

const base: MessageEvent = {
  externalMessageId: "wamid.123",
  direction: "IN",
  timestampMs: 1_700_000_000_000,
  text: "Vamos marcar",
  leadPhone: "5516997220323",
};

describe("buildCommunicationBody", () => {
  it("prefixa com [Lead] quando a direção é IN", () => {
    expect(buildCommunicationBody(base)).toBe("[Lead] Vamos marcar");
  });

  it("prefixa com o nome do atendente quando a direção é OUT", () => {
    const outMessage: MessageEvent = { ...base, direction: "OUT", attendantName: "Felipe Mendes" };
    expect(buildCommunicationBody(outMessage)).toBe("[Felipe Mendes] Vamos marcar");
  });

  it("cai pro nome do autor se não houver nome de atendente", () => {
    const outMessage: MessageEvent = { ...base, direction: "OUT", authorName: "Felipe Mendes" };
    expect(buildCommunicationBody(outMessage)).toBe("[Felipe Mendes] Vamos marcar");
  });
});
