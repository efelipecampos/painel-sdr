import { describe, expect, it } from "vitest";
import { checkManual, gridSlots, windowDays, type AgendaRules } from "./slots";

const hours = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, enabled: true, start_time: "08:20", end_time: "17:45" }))
  .concat([0, 6].map((weekday) => ({ weekday, enabled: false, start_time: "08:00", end_time: "18:00" })));
const rules: AgendaRules = {
  hours, holidays: new Set(["2026-10-12"]), holidaysOff: true, lunchStart: "12:00", lunchEnd: "13:30",
  manualMin: "07:00", manualMax: "20:00", minNoticeMinutes: 120, windowBusinessDays: 10,
};
// sexta 09/10/2026 07:00 em São Paulo
const NOW = new Date("2026-10-09T10:00:00Z");

describe("janela de dias úteis", () => {
  it("pula fim de semana e feriado; hoje entra", () => {
    const d = windowDays(NOW, rules);
    expect(d).toHaveLength(10);
    expect(d.slice(0, 3)).toEqual(["2026-10-09", "2026-10-13", "2026-10-14"]); // 10 e 11 fim de semana, 12 feriado
  });
});

describe("grade", () => {
  it("de 30 em 30 min dentro do expediente, sem almoço, terminando até 17:45", () => {
    const s = gridSlots("2026-10-13", 30, rules, NOW);
    expect(s[0]).toBe("08:30");
    expect(s).toContain("11:30");
    expect(s).not.toContain("12:00");
    expect(s).not.toContain("13:00");
    expect(s).toContain("13:30");
    expect(s[s.length - 1]).toBe("17:00");
  });
  it("duração maior corta o fim e o que encosta no almoço", () => {
    const s = gridSlots("2026-10-13", 60, rules, NOW);
    expect(s).not.toContain("11:30");
    expect(s[s.length - 1]).toBe("16:30");
  });
  it("respeita a antecedência mínima hoje; feriado não tem grade", () => {
    expect(gridSlots("2026-10-09", 30, rules, NOW)[0]).toBe("09:00");
    expect(gridSlots("2026-10-12", 30, rules, NOW)).toEqual([]);
  });
});

describe("ajuste manual", () => {
  it("horário padrão: sem aviso", () => {
    expect(checkManual("2026-10-13T09:10", 40, rules, NOW)).toEqual({ erro: null, avisos: [], foraDoPadrao: false });
  });
  it("almoço e depois das 18h: avisa e marca fora do padrão", () => {
    expect(checkManual("2026-10-13T12:15", 30, rules, NOW)).toMatchObject({ erro: null, avisos: ["Pega o horário de almoço"], foraDoPadrao: true });
    expect(checkManual("2026-10-13T17:50", 30, rules, NOW).avisos).toEqual(["Termina depois das 18:00"]);
    expect(checkManual("2026-10-13T07:30", 30, rules, NOW).avisos).toEqual(["Começa antes das 08:20"]);
    expect(checkManual("2026-10-12T10:00", 30, rules, NOW).avisos).toEqual(["Dia fora do expediente (fim de semana ou feriado)"]);
  });
  it("recusa fora do limite absoluto, sem antecedência, fora da janela ou duração inválida", () => {
    expect(checkManual("2026-10-13T19:45", 30, rules, NOW).erro).toMatch(/entre 07:00 e 20:00/);
    expect(checkManual("2026-10-09T08:30", 30, rules, NOW).erro).toMatch(/antecedência/);
    expect(checkManual("2026-11-30T10:00", 30, rules, NOW).erro).toMatch(/10 dias úteis/);
    expect(checkManual("2026-10-13T10:00", 5, rules, NOW).erro).toMatch(/10 a 240/);
  });
});
