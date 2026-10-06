import { describe, expect, it } from "vitest";
import { addDays, dateToLocal, formatDateTime, formatDuration, localToDate, resolvePeriod } from "./time";

describe("conversão de fuso (America/Sao_Paulo, UTC-3)", () => {
  it("horário local → UTC e de volta", () => {
    expect(localToDate("2026-10-05T09:30").toISOString()).toBe("2026-10-05T12:30:00.000Z");
    expect(localToDate("2026-10-05").toISOString()).toBe("2026-10-05T03:00:00.000Z");
    expect(dateToLocal(new Date("2026-10-06T02:59:00Z"))).toBe("2026-10-05T23:59");
  });

  it("virada do mês e do ano", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("data inválida", () => {
    expect(() => localToDate("05/10/2026")).toThrow();
  });
});

describe("resolvePeriod", () => {
  const now = new Date("2026-10-05T20:00:00Z"); // 17:00 em São Paulo

  it("hoje: 00:00 até 00:00 do dia seguinte, no fuso de negócio", () => {
    const p = resolvePeriod({}, now);
    expect([p.key, p.from.toISOString(), p.to.toISOString(), p.label]).toEqual(
      ["hoje", "2026-10-05T03:00:00.000Z", "2026-10-06T03:00:00.000Z", "Hoje (05/10)"]);
    expect(p.toLocal).toBe("2026-10-05T23:59");
  });

  it("perto da meia-noite em UTC ainda é o dia local", () => {
    const p = resolvePeriod({}, new Date("2026-10-06T02:30:00Z")); // 23:30 do dia 05 em São Paulo
    expect(p.label).toBe("Hoje (05/10)");
  });

  it("ontem e últimos 7 dias", () => {
    expect(resolvePeriod({ periodo: "ontem" }, now).from.toISOString()).toBe("2026-10-04T03:00:00.000Z");
    const w = resolvePeriod({ periodo: "7d" }, now);
    expect([w.from.toISOString(), w.to.toISOString()]).toEqual(["2026-09-29T03:00:00.000Z", "2026-10-06T03:00:00.000Z"]);
  });

  it("personalizado: fim inclusivo no minuto", () => {
    const p = resolvePeriod({ periodo: "custom", de: "2026-10-05T08:20", ate: "2026-10-05T17:44" }, now);
    expect([p.from.toISOString(), p.to.toISOString()]).toEqual(["2026-10-05T11:20:00.000Z", "2026-10-05T20:45:00.000Z"]);
  });

  it("personalizado inválido ou invertido cai em hoje", () => {
    expect(resolvePeriod({ periodo: "custom", de: "x", ate: "y" }, now).key).toBe("hoje");
    expect(resolvePeriod({ periodo: "custom", de: "2026-10-05T10:00", ate: "2026-10-05T09:00" }, now).key).toBe("hoje");
  });
});

describe("formatação", () => {
  it.each([
    [null, "—"], [0, "0s"], [20, "20s"], [178, "2min58"], [3600, "1h00"], [3900, "1h05"], [90000, "1d 1h"],
  ])("formatDuration(%s) = %s", (s, out) => expect(formatDuration(s as number | null)).toBe(out));

  it("formatDateTime no fuso de negócio", () => {
    expect(formatDateTime("2026-10-05T12:01:21Z")).toBe("05/10 09:01");
    expect(formatDateTime(null)).toBe("—");
  });
});
