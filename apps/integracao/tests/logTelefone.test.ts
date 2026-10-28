import { describe, expect, it } from "vitest";
import pino from "pino";
import { mascararTelefone } from "../src/logger.js";

describe("telefone no log (LGPD)", () => {
  it("fica só com os 4 últimos dígitos", () => {
    expect(mascararTelefone("+55 (62) 99155-1234")).toBe("***1234");
    expect(mascararTelefone(null)).toBe("");
  });
  it("o logger mascara leadPhone e rawPhone", () => {
    const linhas: string[] = [];
    const log = pino({ redact: { paths: ["leadPhone", "rawPhone"], censor: mascararTelefone } }, { write: (s: string) => linhas.push(s) });
    log.warn({ rawPhone: "+5562991551234", leadPhone: "5562991551234", contactIds: ["1"] }, "x");
    expect(linhas[0]).not.toContain("991551234");
    expect(linhas[0]).toContain("***1234");
  });
});
