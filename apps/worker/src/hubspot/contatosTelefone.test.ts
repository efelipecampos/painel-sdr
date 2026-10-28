import { describe, expect, it } from "vitest";
import { contatosPorTelefone, nucleoTelefone, variacoesTelefone } from "./contatosTelefone";
import { descartarNoHubspot } from "../jornada/descarte";

describe("contatos do HubSpot com o mesmo telefone", () => {
  it("núcleo ignora DDI, pontuação e o 9º dígito", () => {
    expect(nucleoTelefone("+55 (62) 99155-0000")).toBe("6291550000");
    expect(nucleoTelefone("6291550000")).toBe("6291550000");
    expect(variacoesTelefone("+5562991550000")).toEqual(expect.arrayContaining(["5562991550000", "+5562991550000", "62991550000", "6291550000"]));
  });
  it("junta os achados pela busca exata e pela ampla, só os que têm o mesmo número", async () => {
    const hs = { call: async (_p: string, body: any) => ({ results: body.filterGroups[0].filters[0].operator === "IN"
      ? [{ id: "antigo", properties: { phone: "+5562991550000", mobilephone: null } }]
      : [{ id: "novo", properties: { phone: "+55 (62) 99155-0000", mobilephone: null } }, { id: "outro", properties: { phone: "+55 11 90000-0000", mobilephone: null } }] }) };
    expect((await contatosPorTelefone(hs as any, "+5562991550000")).sort()).toEqual(["antigo", "novo"]);
    expect(await contatosPorTelefone(hs as any, null)).toEqual([]);
  });
  it("descarte com dois contatos: vale o Lead mais recente de todos (o novo, ainda aberto)", async () => {
    const patches: string[] = [];
    const hs = { call: async (p: string, body?: any, method?: string) => {
      if (method === "PATCH") { patches.push(p); return {}; }
      if (p.includes("/contacts/antigo/")) return { results: [{ toObjectId: "L1" }] };
      if (p.includes("/contacts/novo/")) return { results: [{ toObjectId: "L2" }] };
      return { results: [
        { id: "L1", properties: { hs_pipeline: "841793591", hs_pipeline_stage: "1250901141", hs_createdate: "2026-10-23T12:00:00Z" } },
        { id: "L2", properties: { hs_pipeline: "841793591", hs_pipeline_stage: "1250901134", hs_createdate: "2026-10-28T12:30:00Z" } },
      ].filter((l) => body.inputs.some((i: any) => i.id === l.id)) };
    } };
    expect(await descartarNoHubspot(hs as any, ["antigo", "novo"], "Teste", "obs", { prefixo: false, redescartar: true })).toBe("descartado");
    expect(patches).toEqual(["/crm/v3/objects/leads/L2"]);
  });
});
