import { describe, expect, it } from "vitest";
import { brazilianPhoneCandidates } from "../src/hubspot/phone.js";

describe("brazilianPhoneCandidates", () => {
  it("gera variações com e sem DDI e com/sem o 9º dígito", () => {
    const candidates = brazilianPhoneCandidates("5516997220323");

    expect(candidates).toContain("5516997220323");
    expect(candidates).toContain("+5516997220323");
    expect(candidates).toContain("16997220323");
    expect(candidates).toContain("551697220323");
    expect(candidates).toContain("1697220323");
  });

  it("lida com número já formatado com pontuação", () => {
    const candidates = brazilianPhoneCandidates("+55 (16) 99722-0323");
    expect(candidates).toContain("5516997220323");
  });

  it("retorna vazio para entrada vazia", () => {
    expect(brazilianPhoneCandidates("")).toEqual([]);
  });
});
