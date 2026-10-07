import { describe, expect, it } from "vitest";
import { AlertState, alertText, filaParada, poliMuda } from "./alert-rules";

const MIN = 60_000;
const t0 = Date.parse("2026-10-07T13:00:00Z");

describe("AlertState", () => {
  it("só avisa quando a falha dura o limite, e uma vez só", () => {
    const s = new AlertState();
    expect(s.report("worker", false, t0, 5)).toBeNull();
    expect(s.report("worker", false, t0 + 4 * MIN, 5)).toBeNull();
    expect(s.report("worker", false, t0 + 5 * MIN, 5)).toEqual({ key: "worker", kind: "problema", minutos: 5 });
    expect(s.report("worker", false, t0 + 6 * MIN, 5)).toBeNull();
    expect(s.report("worker", false, t0 + 60 * MIN, 5)).toBeNull();
  });

  it("avisa que resolveu, com a duração desde a primeira falha", () => {
    const s = new AlertState();
    s.report("painel", false, t0, 5);
    s.report("painel", false, t0 + 5 * MIN, 5);
    expect(s.report("painel", true, t0 + 12 * MIN, 5)).toEqual({ key: "painel", kind: "resolvido", minutos: 12 });
    expect(s.report("painel", true, t0 + 13 * MIN, 5)).toBeNull();
  });

  it("falha curta que se resolve antes do limite não avisa nada", () => {
    const s = new AlertState();
    s.report("hubspot", false, t0, 30);
    expect(s.report("hubspot", true, t0 + 10 * MIN, 30)).toBeNull();
    // e a contagem recomeça do zero na próxima falha
    expect(s.report("hubspot", false, t0 + 20 * MIN, 30)).toBeNull();
    expect(s.report("hubspot", false, t0 + 49 * MIN, 30)).toBeNull();
    expect(s.report("hubspot", false, t0 + 50 * MIN, 30)?.kind).toBe("problema");
  });

  it("limite 0 avisa na primeira falha (a condição já mede o tempo)", () => {
    const s = new AlertState();
    expect(s.report("fila", false, t0, 0)).toEqual({ key: "fila", kind: "problema", minutos: 0 });
  });

  it("cada alerta tem seu próprio estado", () => {
    const s = new AlertState();
    s.report("worker", false, t0, 0);
    expect(s.report("painel", false, t0, 0)?.kind).toBe("problema");
    expect(s.report("painel", true, t0 + MIN, 0)?.kind).toBe("resolvido");
    expect(s.report("worker", false, t0 + MIN, 0)).toBeNull();
  });
});

describe("filaParada", () => {
  const now = new Date(t0);
  it("sem evento esperando não é fila parada", () => {
    expect(filaParada(null, now, 10)).toBe(false);
  });
  it("evento esperando há menos que o limite ainda não é fila parada", () => {
    expect(filaParada(new Date(t0 - 9 * MIN), now, 10)).toBe(false);
  });
  it("evento esperando há o limite ou mais é fila parada", () => {
    expect(filaParada(new Date(t0 - 10 * MIN), now, 10)).toBe(true);
    expect(filaParada(new Date(t0 - 3 * 60 * MIN), now, 10)).toBe(true);
  });
});

describe("poliMuda", () => {
  it("conta só o tempo em horário comercial (vem de painel.business_seconds)", () => {
    expect(poliMuda(29 * 60, 30)).toBe(false);
    expect(poliMuda(30 * 60, 30)).toBe(true);
    // fim de semana inteiro sem evento, mas 0 s de horário comercial: não alerta
    expect(poliMuda(0, 30)).toBe(false);
  });
  it("sem nenhum evento ainda não alerta", () => {
    expect(poliMuda(null, 30)).toBe(false);
  });
});

describe("alertText", () => {
  it("problema traz o detalhe; resolvido traz a duração", () => {
    expect(alertText({ key: "worker", kind: "problema", minutos: 5 }, "Último erro: x"))
      .toBe("🔴 *Painel SDR:* o worker está com erro há 5 min.\nÚltimo erro: x");
    expect(alertText({ key: "poli", kind: "problema", minutos: 42 })).toContain("nenhum evento da Poli há 42 min em horário comercial");
    expect(alertText({ key: "fila", kind: "resolvido", minutos: 12 }))
      .toBe("✅ *Painel SDR:* a fila de eventos voltou a andar (problema durou 12 min).");
  });
});
