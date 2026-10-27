// "Respondeu algum dia de prospecção?" no Lead do HubSpot (decisão do Felipe, 2026-10-26): o dia da cadência em que
// o lead respondeu pela primeira vez. Qual dia vem do banco (painel.leads_para_marcar_dia, pela etapa do Lead no
// momento da resposta); aqui só grava no HubSpot e registra. Grava uma vez e não muda.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { HubspotClient } from "./leads.js";

export const DIA_PROP = "respondeu_algum_dia_de_prospeccao";
const LOTE = 100; // limite do batch/update do HubSpot

type Pendente = { hubspot_lead_id: string; dia: string | null };

/** Marca os Leads pendentes, em lotes. Devolve quantos foram marcados no HubSpot nesta rodada. */
export async function marcarDiaResposta(db: SupabaseClient, hs: Pick<HubspotClient, "call">, maxLotes = 5): Promise<number> {
  const p = db.schema("painel");
  let total = 0;
  for (let i = 0; i < maxLotes; i++) {
    const { data, error } = await p.rpc("leads_para_marcar_dia", { p_limit: LOTE });
    if (error) throw new Error(`ler Leads para marcar o dia da resposta: ${error.message}`);
    const rows = (data ?? []) as Pendente[];
    if (!rows.length) break;
    const comDia = rows.filter((r) => r.dia);
    const marcados = new Set<string>();
    if (comDia.length) {
      try {
        await hs.call("/crm/v3/objects/leads/batch/update", {
          inputs: comDia.map((r) => ({ id: r.hubspot_lead_id, properties: { [DIA_PROP]: r.dia } })),
        });
        comDia.forEach((r) => marcados.add(r.hubspot_lead_id));
      } catch {
        // um Lead apagado no HubSpot derruba o lote inteiro: marca um por um e pula os que não existem mais
        for (const r of comDia) {
          try {
            await hs.call(`/crm/v3/objects/leads/${r.hubspot_lead_id}`, { properties: { [DIA_PROP]: r.dia } }, "PATCH");
            marcados.add(r.hubspot_lead_id);
          } catch (err) {
            if (!String((err as Error).message).includes("HTTP 404")) throw err;
          }
        }
      }
    }
    // registra todos (fora da cadência e apagados também), para não voltarem na próxima rodada
    const agora = new Date().toISOString();
    const porValor = new Map<string | null, string[]>();
    for (const r of rows) {
      const v = marcados.has(r.hubspot_lead_id) ? r.dia : null;
      porValor.set(v, [...(porValor.get(v) ?? []), r.hubspot_lead_id]);
    }
    for (const [valor, ids] of porValor) {
      const { error: e2 } = await p.from("hubspot_leads")
        .update({ respondeu_dia: valor, respondeu_dia_marcado_at: agora })
        .in("hubspot_lead_id", ids);
      if (e2) throw new Error(`registrar dia da resposta: ${e2.message}`);
    }
    total += marcados.size;
    if (rows.length < LOTE) break;
  }
  return total;
}
