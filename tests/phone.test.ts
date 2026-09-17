import { describe, expect, it } from "vitest";
import { brazilianPhoneCandidates, corePhoneDigits, phoneSuffix } from "../src/hubspot/phone.js";

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

describe("corePhoneDigits", () => {
  it("reduz formatos equivalentes pro mesmo core (DDD + 8 dígitos, sem DDI/9º dígito)", () => {
    const forms = [
      "553299886563",
      "+5532999886563",
      "32999886563",
      "3299886563",
      "+55(32) 99988-6563",
      "(32) 99988-6563",
    ];
    const cores = forms.map(corePhoneDigits);
    expect(new Set(cores).size).toBe(1);
    expect(cores[0]).toBe("3299886563");
  });
});

describe("phoneSuffix", () => {
  it("pega os últimos N dígitos, ignorando pontuação", () => {
    expect(phoneSuffix("+55(32) 99988-6563", 4)).toBe("6563");
  });
});
