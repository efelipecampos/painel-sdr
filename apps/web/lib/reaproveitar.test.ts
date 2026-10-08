import { describe, expect, it } from "vitest";
import { escolherReaproveitavel, inicioDoPrazo } from "./reaproveitar-regra";

const NOW = new Date("2026-10-20T15:00:00Z");
const r = (status: string, starts_at: string) => ({ status, starts_at });

describe("uma reunião por lead", () => {
  it("prazo: este mês (1º dia, Brasília) ou 30 dias", () => {
    expect(inicioDoPrazo("mes", NOW).toISOString()).toBe("2026-10-01T03:00:00.000Z");
    expect(inicioDoPrazo("30d", NOW).toISOString()).toBe("2026-09-20T15:00:00.000Z");
  });
  it("agendada futura sempre reaproveita; cancelada e no show só dentro do prazo", () => {
    const ini = inicioDoPrazo("mes", NOW);
    expect(escolherReaproveitavel([r("agendada", "2026-12-01T13:00:00Z")], ini, NOW)?.status).toBe("agendada");
    expect(escolherReaproveitavel([r("cancelada", "2026-10-05T13:00:00Z")], ini, NOW)?.status).toBe("cancelada");
    expect(escolherReaproveitavel([r("noshow", "2026-09-28T13:00:00Z")], ini, NOW)).toBeNull();
    expect(escolherReaproveitavel([r("noshow", "2026-09-28T13:00:00Z")], inicioDoPrazo("30d", NOW), NOW)?.status).toBe("noshow");
  });
  it("validada e invalidada liberam reunião nova; havendo várias, a mais recente", () => {
    const ini = inicioDoPrazo("mes", NOW);
    expect(escolherReaproveitavel([r("validada", "2026-10-10T13:00:00Z"), r("invalidada", "2026-10-11T13:00:00Z")], ini, NOW)).toBeNull();
    expect(escolherReaproveitavel([r("cancelada", "2026-10-02T13:00:00Z"), r("noshow", "2026-10-15T13:00:00Z")], ini, NOW)?.starts_at).toBe("2026-10-15T13:00:00Z");
  });
});
