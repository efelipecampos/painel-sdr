import { describe, expect, it } from "vitest";
import { agoraNegocio, diaUtilDoMes, textoDesequilibrio } from "./desequilibrio";

describe("alerta de desequilíbrio do carrossel", () => {
  it("conta o dia útil do mês (seg a sex, fora feriados); fim de semana é 0", () => {
    expect(diaUtilDoMes("2026-10-01", new Set())).toBe(1);            // quinta
    expect(diaUtilDoMes("2026-10-14", new Set())).toBe(10);           // 10º dia útil de outubro/2026
    expect(diaUtilDoMes("2026-10-14", new Set(["2026-10-12"]))).toBe(9); // com o feriado de 12/10
    expect(diaUtilDoMes("2026-10-17", new Set())).toBe(0);            // sábado
  });
  it("hora no fuso de São Paulo", () => {
    expect(agoraNegocio(new Date("2026-10-28T12:05:00Z"))).toEqual({ dia: "2026-10-28", hora: "09:05" });
  });
  it("avisa só quem está 3 ou mais abaixo do esperado, do mais atrasado para o menos", () => {
    const t = textoDesequilibrio([
      { carrossel: "Poli · Pequeno", closer: "Ana", recebidas: 10, esperadas: 12.5 },
      { carrossel: "Poli · Pequeno", closer: "Bia", recebidas: 6, esperadas: 10 },
      { carrossel: "ChatsHub · Médio", closer: "Caio", recebidas: 2, esperadas: 5 },
    ])!;
    expect(t).not.toContain("Ana");
    expect(t.indexOf("Bia")).toBeLessThan(t.indexOf("Caio"));
    expect(textoDesequilibrio([{ carrossel: "x", closer: "Ana", recebidas: 5, esperadas: 7 }])).toBeNull();
  });
});
