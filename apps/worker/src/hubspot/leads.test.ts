import { describe, expect, it } from "vitest";
import { toRow } from "./leads";

describe("toRow", () => {
  it("converte um Lead da API do HubSpot na linha de painel.hubspot_leads", () => {
    const row = toRow(
      {
        id: "123",
        properties: {
          hs_pipeline: "841793591", hs_pipeline_stage: "1250901141", hubspot_owner_id: "83827881",
          hs_createdate: "2026-10-01T13:03:54.823Z", hs_lastmodifieddate: "2026-10-02T14:09:48.580Z",
        },
      },
      "252328693679",
    );
    expect(row).toMatchObject({
      hubspot_lead_id: "123", hubspot_contact_id: "252328693679", pipeline_id: "841793591",
      stage_id: "1250901141", owner_id: "83827881", created_at: "2026-10-01T13:03:54.823Z", updated_at: "2026-10-02T14:09:48.580Z",
    });
  });

  it("guarda quando o Lead entrou em Descartado e em DSQ", () => {
    const row = toRow(
      { id: "1", properties: { hs_v2_date_entered_1250901141: "2026-10-05T15:00:00Z", hs_v2_date_entered_1250901142: null } },
      "c", { descartado: "1250901141", dsq: "1250901142" },
    );
    expect(row).toMatchObject({ entered_descartado_at: "2026-10-05T15:00:00Z", entered_dsq_at: null });
  });

  it("agendado = primeira entrada em qualquer etapa de agendamento", () => {
    const row = toRow(
      { id: "2", properties: { hs_v2_date_entered_1250901139: "2026-10-07T12:00:00Z", hs_v2_date_entered_1358962969: "2026-10-07T10:00:00Z" } },
      "c", { descartado: null, dsq: null, agendado: ["1250901139", "1358962969"] },
    );
    expect(row.entered_agendado_at).toBe("2026-10-07T10:00:00Z");
    expect(toRow({ id: "3", properties: {} }, "c", { descartado: null, dsq: null, agendado: ["1250901139"] }).entered_agendado_at).toBeNull();
  });

  it("guarda as datas de entrada nas etapas da cadência e nas de saída dela", () => {
    const stages = { descartado: "DESC", dsq: "DSQ", agendado: ["GA"], cadencia: ["D1", "D2"] };
    const row = toRow({ id: "4", properties: {
      hs_v2_date_entered_D1: "2026-10-20T12:00:00Z", hs_v2_date_entered_D2: "2026-10-21T12:00:00Z",
      hs_v2_date_entered_GA: "2026-10-21T15:00:00Z", hs_v2_date_entered_DSQ: null,
    } }, "c", stages);
    expect(row.etapas_entrada).toEqual({ D1: "2026-10-20T12:00:00Z", D2: "2026-10-21T12:00:00Z", GA: "2026-10-21T15:00:00Z" });
    expect(toRow({ id: "5", properties: {} }, "c", stages).etapas_entrada).toBeNull();
    expect(toRow({ id: "6", properties: { hs_v2_date_entered_DESC: "2026-10-22T10:00:00Z" } }, "c", { descartado: "DESC", dsq: null }).etapas_entrada).toBeNull();
  });

  it("Lead sem contato associado e sem propriedades", () => {
    expect(toRow({ id: "9", properties: {} }, null)).toMatchObject({ hubspot_contact_id: null, stage_id: null, owner_id: null });
  });
});
