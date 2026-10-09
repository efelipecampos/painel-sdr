import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ciclo, diferencas, gravarCamposContato } from "./contatos.js";

describe("diferencas e ciclo", () => {
  it("só o que mudou; primeira vez grava tudo", () => {
    expect(diferencas({ a: "1", b: "2" }, { a: "1", b: "x" })).toEqual({ b: "2" });
    expect(diferencas({ a: "1" }, null)).toEqual({ a: "1" });
    expect(ciclo({ poli_template_da_prospeccao: "t", poli_ultima_mensagem_em: "1" })).toEqual({ poli_template_da_prospeccao: "t" });
  });
});

function fakeDb(pend: unknown[]) {
  const updates: Record<string, unknown>[] = [];
  const painel = {
    rpc: async () => ({ data: pend, error: null }),
    from: () => ({ update: (v: Record<string, unknown>) => ({ eq: () => ({ eq: async () => { updates.push(v); return { error: null }; } }) }) }),
  };
  return { db: { schema: () => painel } as unknown as SupabaseClient, updates };
}

describe("gravarCamposContato", () => {
  const atual = {
    poli_ultima_mensagem_em: "2", poli_direcao_ultima_mensagem: "RECEBIDA", poli_aguardando_resposta: "true",
    link_do_chat_na_poli: "https://app.poli.digital/chat/u", poli_template_da_prospeccao: "abertura", poli_primeira_resposta_em: "9",
  };

  it("grava no contato só o que mudou; nos negócios abertos, o ciclo que mudou e o link só onde está vazio", async () => {
    const { db, updates } = fakeDb([{
      hubspot_contact_id: "C1", marcado_em: "t", atual,
      anterior: { ...atual, poli_ultima_mensagem_em: "1", poli_primeira_resposta_em: "" },
      negocios_anterior: { poli_template_da_prospeccao: "abertura", poli_primeira_resposta_em: "" },
    }]);
    const calls: { path: string; body: any }[] = [];
    const call = async (path: string, body?: any) => {
      calls.push({ path, body });
      if (path.includes("associations")) return { results: [{ from: { id: "C1" }, to: [{ toObjectId: 10 }, { toObjectId: 11 }, { toObjectId: 12 }] }] } as never;
      if (path.endsWith("deals/batch/read")) return { results: [
        { id: "10", properties: { hs_is_closed_won: "false", hs_is_closed_lost: "false", link_do_chat_na_poli: "" } },
        { id: "11", properties: { hs_is_closed_won: "false", hs_is_closed_lost: "false", link_do_chat_na_poli: "outro" } },
        { id: "12", properties: { hs_is_closed_won: "true", hs_is_closed_lost: "false", link_do_chat_na_poli: "" } },
      ] } as never;
      return {} as never;
    };
    expect(await gravarCamposContato(db, { call })).toEqual({ contatos: 1, negocios: 2 });
    expect(calls.find((c) => c.path === "/crm/v3/objects/contacts/batch/update")!.body.inputs)
      .toEqual([{ id: "C1", properties: { poli_ultima_mensagem_em: "2", poli_primeira_resposta_em: "9" } }]);
    expect(calls.find((c) => c.path === "/crm/v3/objects/deals/batch/update")!.body.inputs).toEqual([
      { id: "10", properties: { poli_primeira_resposta_em: "9", link_do_chat_na_poli: "https://app.poli.digital/chat/u" } },
      { id: "11", properties: { poli_primeira_resposta_em: "9" } },
    ]);
    expect(updates[0]).toMatchObject({ sujo: false, valores: atual, negocios_valores: { poli_template_da_prospeccao: "abertura", poli_primeira_resposta_em: "9" } });
  });

  it("nada mudou: não chama o HubSpot e só limpa o sujo", async () => {
    const { db, updates } = fakeDb([{ hubspot_contact_id: "C1", marcado_em: "t", atual, anterior: atual, negocios_anterior: { poli_template_da_prospeccao: "abertura", poli_primeira_resposta_em: "9" } }]);
    const calls: string[] = [];
    expect(await gravarCamposContato(db, { call: async (p: string) => { calls.push(p); return {} as never; } })).toEqual({ contatos: 0, negocios: 0 });
    expect(calls).toEqual([]);
    expect(updates).toHaveLength(1);
  });

  it("HubSpot fora do ar: erro sobe e o contato continua sujo", async () => {
    const { db, updates } = fakeDb([{ hubspot_contact_id: "C1", marcado_em: "t", atual, anterior: null, negocios_anterior: null }]);
    await expect(gravarCamposContato(db, { call: async () => { throw new Error("HTTP 503"); } })).rejects.toThrow(/503/);
    expect(updates).toEqual([]);
  });
});
