// Score da IA no Contato do HubSpot (decisão do Felipe, 2026-10-28): a nota mais recente de cada contato vai para o
// campo ia_score ("[IA] Score") sempre que muda. Quem entra vem do banco (painel.scores_para_hubspot: só avaliação
// com nota, a última de cada contato, ainda não enviada); aqui só grava no HubSpot e registra o envio.
// LGPD: nada de nome, telefone ou conversa; o log só tem contagens.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { HubspotClient } from "./leads.js";

export const SCORE_PROP = "ia_score";
const LOTE = 100; // limite do batch/update do HubSpot

type Pendente = { score_id: number; hubspot_contact_id: string; score: number };

/** Envia as notas pendentes, em lotes. Devolve quantos Contatos receberam a nota nesta rodada. */
export async function enviarScores(db: SupabaseClient, hs: Pick<HubspotClient, "call">, maxLotes = 5): Promise<number> {
  const p = db.schema("painel");
  let total = 0;
  for (let i = 0; i < maxLotes; i++) {
    const { data, error } = await p.rpc("scores_para_hubspot", { p_limit: LOTE });
    if (error) throw new Error(`ler notas para o HubSpot: ${error.message}`);
    const rows = (data ?? []) as Pendente[];
    if (!rows.length) break;
    const input = (r: Pendente) => ({ id: r.hubspot_contact_id, properties: { [SCORE_PROP]: String(r.score) } });
    let enviados = rows.length;
    try {
      await hs.call("/crm/v3/objects/contacts/batch/update", { inputs: rows.map(input) });
    } catch {
      // um Contato apagado (ou mesclado) no HubSpot derruba o lote inteiro: envia um por um e pula os que sumiram
      enviados = 0;
      for (const r of rows) {
        try {
          await hs.call(`/crm/v3/objects/contacts/${r.hubspot_contact_id}`, { properties: input(r).properties }, "PATCH");
          enviados++;
        } catch (err) {
          if (!String((err as Error).message).includes("HTTP 404")) throw err;
        }
      }
    }
    // registra todos (os apagados também), para não voltarem na próxima rodada
    const { error: e2 } = await p.from("lead_scores").update({ hubspot_synced_at: new Date().toISOString() }).in("id", rows.map((r) => r.score_id));
    if (e2) throw new Error(`registrar envio das notas: ${e2.message}`);
    total += enviados;
    if (rows.length < LOTE) break;
  }
  return total;
}
