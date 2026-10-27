import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DIA_PROP, marcarDiaResposta } from "./diaResposta.js";

/** Banco falso: devolve os pendentes uma vez e guarda o que foi registrado. */
function fakeDb(pendentes: { hubspot_lead_id: string; dia: string | null }[]) {
  const registros: { valor: string | null; ids: string[] }[] = [];
  let lido = false;
  const painel = {
    rpc: async () => { const data = lido ? [] : pendentes; lido = true; return { data, error: null }; },
    from: () => ({ update: (v: { respondeu_dia: string | null }) => ({ in: async (_c: string, ids: string[]) => { registros.push({ valor: v.respondeu_dia, ids }); return { error: null }; } }) }),
  };
  return { db: { schema: () => painel } as unknown as SupabaseClient, registros };
}

describe("marcarDiaResposta", () => {
  it("grava o dia de cada Lead em lote; quem respondeu fora da cadência só é registrado", async () => {
    const { db, registros } = fakeDb([
      { hubspot_lead_id: "A", dia: "Respondeu D1" }, { hubspot_lead_id: "B", dia: "Respondeu D3" }, { hubspot_lead_id: "C", dia: null },
    ]);
    const corpos: unknown[] = [];
    const n = await marcarDiaResposta(db, { call: async (_p: string, body?: unknown) => { corpos.push(body); return {} as never; } });
    expect(n).toBe(2);
    expect(corpos).toEqual([{ inputs: [
      { id: "A", properties: { [DIA_PROP]: "Respondeu D1" } }, { id: "B", properties: { [DIA_PROP]: "Respondeu D3" } },
    ] }]);
    expect(registros).toEqual([
      { valor: "Respondeu D1", ids: ["A"] }, { valor: "Respondeu D3", ids: ["B"] }, { valor: null, ids: ["C"] },
    ]);
  });

  it("Lead apagado no HubSpot: marca os outros um por um e registra o apagado sem dia", async () => {
    const { db, registros } = fakeDb([{ hubspot_lead_id: "A", dia: "Respondeu D2" }, { hubspot_lead_id: "SUMIU", dia: "Respondeu D2" }]);
    const call = async (path: string) => {
      if (path.endsWith("batch/update")) throw new Error("HubSpot batch: HTTP 400");
      if (path.endsWith("/SUMIU")) throw new Error("HubSpot SUMIU: HTTP 404");
      return {} as never;
    };
    expect(await marcarDiaResposta(db, { call })).toBe(1);
    expect(registros).toEqual([{ valor: "Respondeu D2", ids: ["A"] }, { valor: null, ids: ["SUMIU"] }]);
  });

  it("HubSpot fora do ar: erro sobe e nada é registrado (tenta de novo na próxima rodada)", async () => {
    const { db, registros } = fakeDb([{ hubspot_lead_id: "A", dia: "Respondeu D1" }]);
    await expect(marcarDiaResposta(db, { call: async () => { throw new Error("HTTP 503"); } })).rejects.toThrow(/503/);
    expect(registros).toEqual([]);
  });
});
