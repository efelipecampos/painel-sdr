import { describe, expect, it } from "vitest";
import { semanasDaJanela } from "./slots";

describe("semanas da grade", () => {
  it("agrupa a janela de seg a sex; feriado, passado e fora da janela ficam fechados", () => {
    const janela = ["2026-10-09", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-19"];
    const w = semanasDaJanela(janela, new Set(["2026-10-12"]));
    expect(w.map((x) => x.label)).toEqual(["05 a 09 de outubro", "12 a 16 de outubro", "19 a 23 de outubro"]);
    expect(w[0].days.map((d) => d.closed)).toEqual(["Já passou.", "Já passou.", "Já passou.", "Já passou.", null]);
    expect(w[1].days[0]).toEqual({ day: "2026-10-12", closed: "Feriado. Sem agendamento." });
    expect(w[2].days[1].closed).toBe("Fora da janela de agendamento.");
  });
  it("semana que vira o mês", () => {
    expect(semanasDaJanela(["2026-09-30"], new Set())[0].label).toBe("28 de setembro a 02 de outubro");
  });
});
