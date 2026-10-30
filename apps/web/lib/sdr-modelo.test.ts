import { describe, expect, it } from "vitest";
import { anterior, coletivo, daEdicao, fmtFaixa, fmtValor, impedimento, mudancas, paraEdicao, resolveDias, textoAnterior, type Comportamento } from "./sdr-modelo";

// sexta 30/10/2026 10:00 em São Paulo
const NOW = new Date("2026-10-30T13:00:00Z");

describe("período em dias", () => {
  it("padrão: últimos 30 dias com hoje; até é inclusive", () => {
    const p = resolveDias({}, NOW);
    expect([p.de, p.ate, p.dias]).toEqual(["2026-10-01", "2026-10-30", 30]);
    expect(p.from.toISOString()).toBe("2026-10-01T03:00:00.000Z");
    expect(p.to.toISOString()).toBe("2026-10-31T03:00:00.000Z");
  });
  it("datas invertidas são trocadas; inválidas caem no padrão", () => {
    expect(resolveDias({ de: "2026-10-14", ate: "2026-10-01" }, NOW)).toMatchObject({ de: "2026-10-01", ate: "2026-10-14", dias: 14 });
    expect(resolveDias({ de: "x", ate: "2026-10-10" }, NOW)).toMatchObject({ de: "2026-09-11", ate: "2026-10-10" });
  });
  it("período anterior do mesmo tamanho", () => {
    expect(anterior(resolveDias({ de: "2026-10-15", ate: "2026-10-28" }, NOW))).toMatchObject({ de: "2026-10-01", ate: "2026-10-14", dias: 14 });
  });
});

describe("formatação", () => {
  it("por unidade", () => {
    expect(fmtValor("leads/dia", 63.2)).toBe("63,2");
    expect(fmtValor("s", 188)).toBe("3min08");
    expect(fmtValor("%", 8)).toBe("8%");
    expect(fmtValor("%", 14.9)).toBe("14,9%");
    expect(fmtValor("nota", null)).toBe("—");
    expect(fmtFaixa("%", 6, 8.2)).toBe("6% a 8,2%");
    expect(fmtFaixa("s", null, 10)).toBe("sem faixa");
  });
  it("comparação com o período anterior", () => {
    expect(textoAnterior(61, 51)).toBe("+10 desde o período anterior (51)");
    expect(textoAnterior(50, 61)).toBe("−11 desde o período anterior (61)");
    expect(textoAnterior(50, null)).toBe("Sem comparação com o período anterior");
  });
});

describe("treino coletivo", () => {
  it("metade ou mais dos avaliados fora; amostra pequena não conta", () => {
    expect(coletivo(["acima", "dentro", "amostra_pequena"])).toEqual({ fora: 1, avaliados: 2, coletivo: true });
    expect(coletivo(["abaixo", "dentro", "melhor"])).toEqual({ fora: 1, avaliados: 3, coletivo: false });
    expect(coletivo(["sem_dado"])).toEqual({ fora: 0, avaliados: 0, coletivo: false });
  });
});

describe("edição do SDR Ideal", () => {
  const base: Comportamento[] = [
    { id: "pri", grupo: "num", nome: "1ª resposta", medida: "", unidade: "s", lo: 188, hi: 1222, melhor: -1, peso: 50, ativo: true },
    { id: "tax", grupo: "num", nome: "Taxa", medida: "", unidade: "%", lo: 14.9, hi: 28.2, melhor: 1, peso: 50, ativo: true },
    { id: "per", grupo: "ia", nome: "Perguntas", medida: "", unidade: "nota", lo: 7, hi: 9, melhor: 1, peso: 5, ativo: false, descricao: "Perguntas boas" },
  ];
  it("tempo em minutos na tela e segundos no banco; sem mudança, lista vazia", () => {
    const rows = base.map(paraEdicao);
    expect([rows[0].lo, rows[0].hi]).toEqual(["3.1", "20.4"]);
    expect(daEdicao({ ...rows[0], lo: "2", hi: "6,5" })).toMatchObject({ lo: 120, hi: 390 });
    expect(mudancas(base, rows)).toEqual([]);
    expect(impedimento(rows)).toBeNull();
  });
  it("descreve as mudanças e confere as regras", () => {
    const rows = base.map(paraEdicao);
    rows[0] = { ...rows[0], lo: "2", hi: "6", peso: "40" };
    rows[1] = { ...rows[1], melhor: "0" };
    rows[2] = { ...rows[2], ativo: true, peso: "10" };
    expect(mudancas(base, rows)).toEqual([
      "1ª resposta: peso 50 → 40", "1ª resposta: faixa 3,1 a 20,4 → 2 a 6 min", "Taxa: maior é melhor → só a faixa", "Perguntas ligado", "Perguntas: peso 5 → 10",
    ]);
    expect(impedimento(rows)).toBeNull();
    expect(impedimento([{ ...rows[0], peso: "45" }, rows[1], rows[2]])).toMatch(/somam 105/);
    expect(impedimento([{ ...rows[0], lo: "9" }, rows[1], rows[2]])).toMatch(/"de" maior/);
    expect(impedimento([rows[0], rows[1], { ...rows[2], descricao: " " }])).toMatch(/o que a IA olha/);
  });
});
