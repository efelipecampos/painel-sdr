import { describe, expect, it } from "vitest";
import { camposDiferentes, camposPainel, quemVale, semHubspot, statusDoHubspot } from "./reunioesAgenda";

describe("status vindo do HubSpot", () => {
  it("correspondência combinada; Rescheduled conta como agendada", () => {
    expect(statusDoHubspot("COMPLETED", null)).toEqual({ status: "validada", outcome: "COMPLETED" });
    expect(statusDoHubspot("NO_SHOW", null)?.status).toBe("noshow");
    expect(statusDoHubspot("INVALIDADO", null)?.status).toBe("invalidada");
    expect(statusDoHubspot("CANCELED", null)?.status).toBe("cancelada");
    expect(statusDoHubspot("SCHEDULED", null)?.status).toBe("agendada");
    expect(statusDoHubspot("RESCHEDULED", null)?.status).toBe("agendada");
  });
  it("a Reunião do Calendar manda; a antiga do painel só com resultado final", () => {
    expect(statusDoHubspot("NO_SHOW", "COMPLETED")?.status).toBe("noshow");
    expect(statusDoHubspot(null, "COMPLETED")?.status).toBe("validada");
    expect(statusDoHubspot(null, "SCHEDULED")).toBeNull();
    expect(statusDoHubspot(null, null)).toBeNull();
    expect(statusDoHubspot("VALOR_NOVO", null)).toBeNull();
  });
});

describe("no Calendar e não no HubSpot", () => {
  const now = Date.parse("2026-10-28T15:00:00Z");
  const base = { status: "agendada", google_event_id: "ev1", hubspot_agenda_meeting_id: null, hubspot_meeting_id: null, created_at: "2026-10-28T14:00:00Z" };
  it("sem nenhuma Reunião no HubSpot depois de 10 min", () => {
    expect(semHubspot(base, now)).toBe(true);
    expect(semHubspot({ ...base, created_at: "2026-10-28T14:55:00Z" }, now)).toBe(false);
  });
  it("achada (do Calendar ou antiga do painel), cancelada ou sem evento: não avisa", () => {
    expect(semHubspot({ ...base, hubspot_agenda_meeting_id: "m1" }, now)).toBe(false);
    expect(semHubspot({ ...base, hubspot_meeting_id: "m0" }, now)).toBe(false);
    expect(semHubspot({ ...base, status: "cancelada" }, now)).toBe(false);
    expect(semHubspot({ ...base, google_event_id: null }, now)).toBe(false);
  });
});

describe("campos que o painel impõe na Reunião do Calendar", () => {
  it("SDR, closer e tipo Apresentação; sobrescreve só o que está diferente", () => {
    const quer = camposPainel({ sdr_owner_id: "sdr1", closer_owner_id: "closer1" });
    expect(quer).toEqual({ hs_activity_type: "[Reunião] - Apresentação", sdr_quem_agendou_a_reuniao: "true", atividade_criada_por: "sdr1",
      hubspot_owner_id: "closer1", closer_responsavel_pela_reuniao: "closer1" });
    expect(camposDiferentes(quer, { hs_activity_type: "[Call] Follow Up", sdr_quem_agendou_a_reuniao: "true", atividade_criada_por: "sdr1", hubspot_owner_id: "outro", closer_responsavel_pela_reuniao: "closer1" }))
      .toEqual({ hs_activity_type: "[Reunião] - Apresentação", hubspot_owner_id: "closer1" });
    expect(camposDiferentes(quer, { ...quer })).toEqual({});
  });
  it("sem dono no HubSpot: não mexe nesse campo", () => {
    expect(camposPainel({ sdr_owner_id: null, closer_owner_id: null })).toEqual({ hs_activity_type: "[Reunião] - Apresentação", sdr_quem_agendou_a_reuniao: "true" });
  });
});

describe("status mudou no painel e no HubSpot: vale a última mudança", () => {
  const m = { status_changed_at: "2026-10-28T13:00:00Z", hubspot_outcome: "SCHEDULED" };
  it("HubSpot igual ao último conhecido: vale o painel", () => {
    expect(quemVale(m, "SCHEDULED", "2026-10-28T14:00:00Z")).toBe("painel");
  });
  it("HubSpot mudou depois do painel: vale o HubSpot; antes: vale o painel", () => {
    expect(quemVale(m, "COMPLETED", "2026-10-28T13:05:00Z")).toBe("hubspot");
    expect(quemVale(m, "COMPLETED", "2026-10-28T12:55:00Z")).toBe("painel");
  });
  it("sem data no HubSpot: vale o painel", () => {
    expect(quemVale(m, "COMPLETED", null)).toBe("painel");
    expect(quemVale({ hubspot_outcome: null }, null, null)).toBe("painel");
  });
});
