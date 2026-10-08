import { describe, expect, it } from "vitest";
import { associations, diffMeeting, dueDailyRun, meetingProps, type MeetingForHubspot } from "./meetings";

const m: MeetingForHubspot = {
  id: "x", status: "noshow", title: "Apresentação Poli - Empresa X", starts_at: "2026-10-12T13:00:00Z", ends_at: "2026-10-12T13:30:00Z",
  meet_url: "https://meet.google.com/abc", hubspot_meeting_id: null, hubspot_contact_id: "c1", hubspot_lead_id: "l1",
  closer_owner_id: "o-closer", sdr_owner_id: "o-sdr",
};

describe("Reunião no HubSpot", () => {
  it("campos combinados: closer dono, SDR em 'Atividade criada pelo SDR', título, horários e Meet no local", () => {
    expect(meetingProps(m, false)).toEqual({
      hs_timestamp: "2026-10-12T13:00:00.000Z", hs_meeting_title: "Apresentação Poli - Empresa X",
      hs_meeting_start_time: "2026-10-12T13:00:00.000Z", hs_meeting_end_time: "2026-10-12T13:30:00.000Z",
      hs_meeting_location: "https://meet.google.com/abc", hubspot_owner_id: "o-closer", atividade_criada_por: "o-sdr",
    });
  });
  it("status só quando pedido, com a correspondência combinada", () => {
    expect(meetingProps(m, true).hs_meeting_outcome).toBe("NO_SHOW");
    expect(meetingProps({ ...m, status: "invalidada" }, true).hs_meeting_outcome).toBe("INVALIDADO");
    expect(meetingProps({ ...m, status: "validada" }, true).hs_meeting_outcome).toBe("COMPLETED");
    expect(meetingProps({ ...m, status: "cancelada" }, true).hs_meeting_outcome).toBe("CANCELED");
    expect(meetingProps({ ...m, status: "agendada" }, true).hs_meeting_outcome).toBe("SCHEDULED");
  });
  it("liga ao contato (200) e ao Lead (601); sem Lead, só o contato", () => {
    expect(associations(m).map((a) => [a.to.id, a.types[0].associationTypeId])).toEqual([["c1", 200], ["l1", 601]]);
    expect(associations({ ...m, hubspot_lead_id: null })).toHaveLength(1);
  });
});

describe("rodada das 17:55", () => {
  it("roda uma vez por dia, depois das 17:55 em São Paulo", () => {
    expect(dueDailyRun(new Date("2026-10-12T20:54:00Z"), "17:55", "")).toEqual({ due: false, today: "2026-10-12" });
    expect(dueDailyRun(new Date("2026-10-12T20:55:00Z"), "17:55", "")).toEqual({ due: true, today: "2026-10-12" });
    expect(dueDailyRun(new Date("2026-10-12T23:00:00Z"), "17:55", "2026-10-12").due).toBe(false);
    expect(dueDailyRun(new Date("2026-10-13T21:00:00Z"), "17:55", "2026-10-12").due).toBe(true);
  });
});

describe("conferência das 17:55", () => {
  it("aponta campo diferente; data igual em outro formato não é diferença", () => {
    const exp = meetingProps(m, true);
    const same = { ...exp, hs_meeting_start_time: "2026-10-12T13:00:00Z" };
    expect(diffMeeting(exp, same)).toEqual([]);
    expect(diffMeeting(exp, { ...exp, hs_meeting_outcome: "SCHEDULED", hubspot_owner_id: "outro" }).sort()).toEqual(["hs_meeting_outcome", "hubspot_owner_id"]);
    expect(diffMeeting(exp, { ...exp, hs_meeting_end_time: null })).toEqual(["hs_meeting_end_time"]);
  });
});
