import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SCORE_PROP, enviarScores } from "./scoreContato.js";

/** Banco falso: devolve os pendentes uma vez e guarda os ids registrados como enviados. */
function fakeDb(pendentes: { score_id: number; hubspot_contact_id: string; score: number }[]) {
  const registrados: number[][] = [];
  let lido = false;
  const painel = {
    rpc: async () => { const data = lido ? [] : pendentes; lido = true; return { data, error: null }; },
    from: () => ({ update: () => ({ in: async (_c: string, ids: number[]) => { registrados.push(ids); return { error: null }; } }) }),
  };
  return { db: { schema: () => painel } as unknown as SupabaseClient, registrados };
}

describe("enviarScores", () => {
  it("grava a nota de cada Contato em lote e registra o envio", async () => {
    const { db, registrados } = fakeDb([{ score_id: 1, hubspot_contact_id: "10", score: 72 }, { score_id: 2, hubspot_contact_id: "11", score: 0 }]);
    const corpos: unknown[] = [];
    const n = await enviarScores(db, { call: async (_p: string, body?: unknown) => { corpos.push(body); return {} as never; } });
    expect(n).toBe(2);
    expect(corpos).toEqual([{ inputs: [{ id: "10", properties: { [SCORE_PROP]: "72" } }, { id: "11", properties: { [SCORE_PROP]: "0" } }] }]);
    expect(registrados).toEqual([[1, 2]]);
  });

  it("Contato apagado no HubSpot: envia os outros um por um e registra todos", async () => {
    const { db, registrados } = fakeDb([{ score_id: 1, hubspot_contact_id: "10", score: 50 }, { score_id: 2, hubspot_contact_id: "SUMIU", score: 80 }]);
    const call = async (path: string) => {
      if (path.endsWith("batch/update")) throw new Error("HubSpot batch: HTTP 400");
      if (path.endsWith("/SUMIU")) throw new Error("HubSpot SUMIU: HTTP 404");
      return {} as never;
    };
    expect(await enviarScores(db, { call })).toBe(1);
    expect(registrados).toEqual([[1, 2]]);
  });

  it("HubSpot fora do ar: erro sobe e nada é registrado (tenta de novo na próxima rodada)", async () => {
    const { db, registrados } = fakeDb([{ score_id: 1, hubspot_contact_id: "10", score: 50 }]);
    await expect(enviarScores(db, { call: async () => { throw new Error("HTTP 503"); } })).rejects.toThrow(/503/);
    expect(registrados).toEqual([]);
  });

  it("sem pendentes: não chama o HubSpot", async () => {
    const { db } = fakeDb([]);
    let chamou = false;
    expect(await enviarScores(db, { call: async () => { chamou = true; return {} as never; } })).toBe(0);
    expect(chamou).toBe(false);
  });
});
