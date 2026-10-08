import { describe, expect, it } from "vitest";
import { currentSlot, DEFAULT_SCORE_TIMES, parseTimes } from "./schedule.js";

// Horário de Brasília = UTC−3
const at = (iso: string) => new Date(`${iso}-03:00`);

describe("horários do score", () => {
  it("padrão: de 2 em 2 horas, das 8 às 18", () => {
    expect(parseTimes(undefined)).toEqual(["08:00", "10:00", "12:00", "14:00", "16:00", "18:00"]);
    expect(parseTimes(" 14:00, 09:30 ")).toEqual(["09:30", "14:00"]);
    expect(() => parseTimes("8h")).toThrow(/SCORE_HORARIOS/);
  });
  it("o horário vale a partir dele até o próximo", () => {
    expect(currentSlot(at("2026-10-08T07:59"), DEFAULT_SCORE_TIMES)).toBeNull();
    expect(currentSlot(at("2026-10-08T08:00"), DEFAULT_SCORE_TIMES)).toBe("2026-10-08 08:00");
    expect(currentSlot(at("2026-10-08T09:59"), DEFAULT_SCORE_TIMES)).toBe("2026-10-08 08:00");
    expect(currentSlot(at("2026-10-08T10:00"), DEFAULT_SCORE_TIMES)).toBe("2026-10-08 10:00");
    expect(currentSlot(at("2026-10-08T23:30"), DEFAULT_SCORE_TIMES)).toBe("2026-10-08 18:00");
  });
  it("usa o fuso de São Paulo, não o do servidor", () => {
    // 01:30 UTC do dia 9 = 22:30 do dia 8 em Brasília
    expect(currentSlot(new Date("2026-10-09T01:30:00Z"), DEFAULT_SCORE_TIMES)).toBe("2026-10-08 18:00");
  });
});
