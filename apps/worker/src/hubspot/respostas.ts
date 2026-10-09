// Marca "Respondeu template" no Lead do HubSpot quando o lead escreve (decisão do Felipe, 2026-10-09).
// O follow-up do n8n só manda mensagem para Lead com o campo desmarcado; o SDR esquecia de marcar à mão.
// Quais Leads marcar vem do banco (painel.leads_para_marcar_resposta); aqui só grava no HubSpot e registra.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { HubspotClient } from "./leads.js";

export const RESPONDEU_PROP = "respondeu_template";
const LOTE = 100; // limite do batch/update do HubSpot

/** Marca os Leads pendentes, em lotes. Devolve quantos foram marcados nesta rodada. */
export async function marcarRespostas(db: SupabaseClient, hs: Pick<HubspotClient, "call">, maxLotes = 5): Promise<number> {
  const p = db.schema("painel");
  let total = 0;
  for (let i = 0; i < maxLotes; i++) {
    const { data, error } = await p.rpc("leads_para_marcar_resposta", { p_limit: LOTE });
    if (error) throw new Error(`ler Leads para marcar resposta: ${error.message}`);
    const ids = ((data ?? []) as { hubspot_lead_id: string }[]).map((r) => r.hubspot_lead_id);
    if (!ids.length) break;
    let marcados = ids;
    const apagados: string[] = [];
    try {
      await hs.call("/crm/v3/objects/leads/batch/update", {
        inputs: ids.map((id) => ({ id, properties: { [RESPONDEU_PROP]: "true" } })),
      });
    } catch {
      // um Lead apagado no HubSpot derruba o lote inteiro: marca um por um e pula os que não existem mais
      marcados = [];
      for (const id of ids) {
        try {
          await hs.call(`/crm/v3/objects/leads/${id}`, { properties: { [RESPONDEU_PROP]: "true" } }, "PATCH");
          marcados.push(id);
        } catch (err) {
          if (String((err as Error).message).includes("HTTP 404")) apagados.push(id);
          else throw err;
        }
      }
    }
    const agora = new Date().toISOString();
    for (const [lista, valor] of [[marcados, true], [apagados, null]] as const) {
      if (!lista.length) continue;
      const { error: e2 } = await p.from("hubspot_leads")
        .update({ respondeu_template: valor, respondeu_marcado_at: agora })
        .in("hubspot_lead_id", lista);
      if (e2) throw new Error(`registrar Leads marcados: ${e2.message}`);
    }
    total += marcados.length;
    if (ids.length < LOTE) break;
  }
  return total;
}
