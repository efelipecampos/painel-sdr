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

  it("Lead sem contato associado e sem propriedades", () => {
    expect(toRow({ id: "9", properties: {} }, null)).toMatchObject({ hubspot_contact_id: null, stage_id: null, owner_id: null });
  });
});
