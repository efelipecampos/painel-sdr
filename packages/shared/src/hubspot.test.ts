import { describe, expect, it } from "vitest";
import { HubspotLive, parseHubspotRef, suggestCarousel } from "./hubspot";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("link ou id do HubSpot", () => {
  it("aceita link de contato, de Lead e id puro; recusa o resto", () => {
    expect(parseHubspotRef("https://app.hubspot.com/contacts/123/record/0-1/456")).toEqual({ kind: "contact", id: "456" });
    expect(parseHubspotRef("https://app.hubspot.com/contacts/123/record/0-136/789?x=1")).toEqual({ kind: "lead", id: "789" });
    expect(parseHubspotRef("https://app.hubspot.com/contacts/123/contact/456/")).toEqual({ kind: "contact", id: "456" });
    expect(parseHubspotRef(" 98765 ")).toEqual({ kind: "id", id: "98765" });
    expect(parseHubspotRef("Maria")).toBeNull();
    expect(parseHubspotRef("https://app.hubspot.com/contacts/123/record/0-2/1")).toBeNull();
  });
});

describe("consulta", () => {
  function fake(routes: Record<string, unknown>) {
    return async (url: string | URL | Request) => {
      const u = String(url).replace("https://api.hubapi.com", "");
      const k = Object.keys(routes).find((p) => u.startsWith(p));
      return k ? json(200, routes[k]) : json(404, {});
    };
  }
  const contact = { id: "1", properties: { firstname: "Maria", lastname: "Souza", email: "M@X.COM", company: "X", phone: null, mobilephone: "+55 62 9", website: "x.com", hubspot_owner_id: "o0", sdr_2_0__quantidade_de_usuarios_a_utilizar_a_plataforma: "4" } };

  it("contato com dois Leads: escolhe o mais recente do pipeline do SDR; usuários do Lead têm prioridade", async () => {
    const hs = new HubspotLive("t", fake({
      "/crm/v3/objects/contacts/1": contact,
      "/crm/v4/objects/contacts/1/associations/leads": { results: [{ toObjectId: 10 }, { toObjectId: 11 }, { toObjectId: 12 }] },
      "/crm/v3/objects/leads/batch/read": { results: [
        { id: "10", properties: { hs_pipeline: "P", hs_pipeline_stage: "s1", hubspot_owner_id: "o1", hs_createdate: "2026-09-01", sdr_2_0__quantidade_de_usuarios_a_utilizar_a_plataforma: "8" } },
        { id: "11", properties: { hs_pipeline: "P", hs_pipeline_stage: "s2", hubspot_owner_id: "o2", hs_createdate: "2026-10-01", sdr_2_0__quantidade_de_usuarios_a_utilizar_a_plataforma: "12" } },
        { id: "12", properties: { hs_pipeline: "Outro", hs_createdate: "2026-10-05" } },
      ] },
    }) as typeof fetch);
    expect(await hs.lookup({ kind: "contact", id: "1" }, "P")).toEqual({
      contactId: "1", leadId: "11", name: "Maria Souza", company: "X", email: "m@x.com", phone: "+55 62 9", website: "x.com",
      ownerId: "o2", stageId: "s2", pipelineId: "P", users: 12,
    });
  });

  it("id puro de Lead: acha o contato associado; contato inexistente devolve null", async () => {
    const hs = new HubspotLive("t", fake({
      "/crm/v3/objects/leads/batch/read": { results: [{ id: "77", properties: { hs_pipeline: "P", hs_createdate: "2026-10-01" } }] },
      "/crm/v4/objects/leads/77/associations/contacts": { results: [{ toObjectId: 1 }] },
      "/crm/v3/objects/contacts/1": contact,
    }) as typeof fetch);
    const r = await hs.lookup({ kind: "id", id: "77" });
    expect(r).toMatchObject({ contactId: "1", leadId: "77", users: 4, ownerId: "o0" });
    expect(await new HubspotLive("t", fake({}) as typeof fetch).lookup({ kind: "contact", id: "9" })).toBeNull();
  });
});

describe("carrossel sugerido", () => {
  const cs = [
    { id: "a", brand: "poli", suggest_min_users: null, suggest_max_users: 5 },
    { id: "b", brand: "poli", suggest_min_users: 6, suggest_max_users: 10 },
    { id: "c", brand: "poli", suggest_min_users: 11, suggest_max_users: null },
    { id: "l", brand: "poli", suggest_min_users: null, suggest_max_users: null },
    { id: "d", brand: "chatshub", suggest_min_users: null, suggest_max_users: 5 },
  ];
  it("pela faixa e pela marca; sem número, sem sugestão; Licitação nunca é sugerida", () => {
    expect(suggestCarousel(3, "poli", cs)?.id).toBe("a");
    expect(suggestCarousel(6, "poli", cs)?.id).toBe("b");
    expect(suggestCarousel(10, "poli", cs)?.id).toBe("b");
    expect(suggestCarousel(50, "poli", cs)?.id).toBe("c");
    expect(suggestCarousel(3, "chatshub", cs)?.id).toBe("d");
    expect(suggestCarousel(null, "poli", cs)).toBeNull();
  });
});
