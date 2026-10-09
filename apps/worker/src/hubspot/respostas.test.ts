import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { marcarRespostas } from "./respostas.js";

/** Banco falso: devolve os pendentes uma vez e guarda o que foi registrado. */
function fakeDb(pendentes: string[]) {
  const registros: { valor: boolean | null; ids: string[] }[] = [];
  let lido = false;
  const painel = {
    rpc: async () => { const data = lido ? [] : pendentes.map((hubspot_lead_id) => ({ hubspot_lead_id })); lido = true; return { data, error: null }; },
    from: () => ({ update: (v: { respondeu_template: boolean | null }) => ({ in: async (_c: string, ids: string[]) => { registros.push({ valor: v.respondeu_template, ids }); return { error: null }; } }) }),
  };
  return { db: { schema: () => painel } as unknown as SupabaseClient, registros };
}

describe("marcarRespostas", () => {
  it("marca em lote e registra", async () => {
    const { db, registros } = fakeDb(["A", "B"]);
    const chamadas: string[] = [];
    const n = await marcarRespostas(db, { call: async (path: string) => { chamadas.push(path); return {} as never; } });
    expect(n).toBe(2);
    expect(chamadas).toEqual(["/crm/v3/objects/leads/batch/update"]);
    expect(registros).toEqual([{ valor: true, ids: ["A", "B"] }]);
  });

  it("Lead apagado no HubSpot: marca os outros um por um e pula o apagado", async () => {
    const { db, registros } = fakeDb(["A", "SUMIU"]);
    const call = async (path: string) => {
      if (path.endsWith("batch/update")) throw new Error("HubSpot batch: HTTP 400");
      if (path.endsWith("/SUMIU")) throw new Error("HubSpot SUMIU: HTTP 404");
      return {} as never;
    };
    expect(await marcarRespostas(db, { call })).toBe(1);
    expect(registros).toEqual([{ valor: true, ids: ["A"] }, { valor: null, ids: ["SUMIU"] }]);
  });

  it("HubSpot fora do ar: erro sobe e nada é registrado (tenta de novo na próxima rodada)", async () => {
    const { db, registros } = fakeDb(["A"]);
    await expect(marcarRespostas(db, { call: async () => { throw new Error("HTTP 503"); } })).rejects.toThrow(/503/);
    expect(registros).toEqual([]);
  });
});
