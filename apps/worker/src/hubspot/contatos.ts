// Campos do Contato e dos Negócios abertos no HubSpot (decisões do Felipe, 2026-10-09; antes eram da integração).
// O banco calcula os valores (painel.campos_contato) e marca quem mudou (painel.hubspot_contato_campos.sujo);
// aqui só grava no HubSpot o que mudou e registra o que foi gravado.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { HubspotClient } from "./leads.js";

type Valores = Record<string, string>;
type Hs = Pick<HubspotClient, "call">;

export const CICLO = ["poli_prospeccao_iniciada_em", "poli_template_da_prospeccao", "poli_primeira_resposta_em", "poli_tempo_ate_resposta_horas"];
const LOTE = 100;

/** Propriedades de `atual` que mudaram em relação ao que já foi gravado. */
export function diferencas(atual: Valores, anterior: Valores | null): Valores {
  return Object.fromEntries(Object.entries(atual).filter(([k, v]) => anterior?.[k] !== v));
}

/** Só os campos do ciclo. */
export function ciclo(v: Valores): Valores {
  return Object.fromEntries(Object.entries(v).filter(([k]) => CICLO.includes(k)));
}

const is404 = (err: unknown) => String((err as Error)?.message).includes("HTTP 404");

/** Grava em lote; se o lote falhar (ex.: um registro apagado), grava um por um e devolve os ids que não existem mais. */
async function gravar(hs: Hs, objeto: "contacts" | "deals", inputs: { id: string; properties: Valores }[]): Promise<Set<string>> {
  const sumiram = new Set<string>();
  if (!inputs.length) return sumiram;
  try {
    await hs.call(`/crm/v3/objects/${objeto}/batch/update`, { inputs });
  } catch {
    for (const i of inputs) {
      try {
        await hs.call(`/crm/v3/objects/${objeto}/${i.id}`, { properties: i.properties }, "PATCH");
      } catch (err) {
        if (is404(err)) sumiram.add(i.id);
        else throw err;
      }
    }
  }
  return sumiram;
}

/** Negócios abertos (nem ganho, nem perdido) de cada contato, com o link atual. */
async function negociosAbertos(hs: Hs, contatos: string[]): Promise<Map<string, { id: string; link: string | null }[]>> {
  const out = new Map<string, { id: string; link: string | null }[]>();
  if (!contatos.length) return out;
  const assoc = await hs.call<{ results: { from: { id: string }; to: { toObjectId: number }[] }[] }>(
    "/crm/v4/associations/contacts/deals/batch/read", { inputs: contatos.map((id) => ({ id })) },
  );
  const dealIds = [...new Set(assoc.results.flatMap((a) => a.to.map((t) => String(t.toObjectId))))];
  const info = new Map<string, { aberto: boolean; link: string | null }>();
  for (let i = 0; i < dealIds.length; i += LOTE) {
    const r = await hs.call<{ results: { id: string; properties: Record<string, string | null> }[] }>("/crm/v3/objects/deals/batch/read", {
      inputs: dealIds.slice(i, i + LOTE).map((id) => ({ id })),
      properties: ["hs_is_closed_won", "hs_is_closed_lost", "link_do_chat_na_poli"],
    });
    for (const d of r.results) {
      info.set(d.id, {
        aberto: d.properties.hs_is_closed_won !== "true" && d.properties.hs_is_closed_lost !== "true",
        link: d.properties.link_do_chat_na_poli || null,
      });
    }
  }
  for (const a of assoc.results) {
    out.set(a.from.id, a.to.map((t) => String(t.toObjectId))
      .filter((id) => info.get(id)?.aberto)
      .map((id) => ({ id, link: info.get(id)!.link })));
  }
  return out;
}

interface Pendente { hubspot_contact_id: string; marcado_em: string; atual: Valores | null; anterior: Valores | null; negocios_anterior: Valores | null }

/** Uma rodada: grava os contatos sujos (até `max`). Devolve quantos contatos e negócios foram atualizados. */
export async function gravarCamposContato(db: SupabaseClient, hs: Hs, max = 200): Promise<{ contatos: number; negocios: number }> {
  const p = db.schema("painel");
  const { data, error } = await p.rpc("contatos_hubspot_pendentes", { p_limit: max });
  if (error) throw new Error(`ler contatos pendentes: ${error.message}`);
  const pend = (data ?? []) as Pendente[];
  let contatos = 0;
  let negocios = 0;
  for (let i = 0; i < pend.length; i += LOTE) {
    const lote = pend.slice(i, i + LOTE);
    // Contato: só o que mudou
    const inputs = lote.flatMap((c) => {
      const d = c.atual ? diferencas(c.atual, c.anterior) : {};
      return Object.keys(d).length ? [{ id: c.hubspot_contact_id, properties: d }] : [];
    });
    const sumiram = await gravar(hs, "contacts", inputs);
    contatos += inputs.length - sumiram.size;

    // Negócios abertos: ciclo quando mudou; link quando o Negócio está sem link
    const precisa = lote.filter((c) => c.atual && !sumiram.has(c.hubspot_contact_id)
      && (Object.keys(diferencas(ciclo(c.atual), c.negocios_anterior)).length || !c.negocios_anterior));
    const abertos = await negociosAbertos(hs, precisa.map((c) => c.hubspot_contact_id));
    const dealInputs = precisa.flatMap((c) => {
      const cic = diferencas(ciclo(c.atual!), c.negocios_anterior);
      const link = c.atual!.link_do_chat_na_poli;
      return (abertos.get(c.hubspot_contact_id) ?? []).flatMap((d) => {
        const props: Valores = { ...cic, ...(!d.link && link ? { link_do_chat_na_poli: link } : {}) };
        return Object.keys(props).length ? [{ id: d.id, properties: props }] : [];
      });
    });
    const dealsSumiram = await gravar(hs, "deals", dealInputs);
    negocios += dealInputs.length - dealsSumiram.size;

    // Registra o que foi gravado; só limpa o "sujo" se não ficou sujo de novo enquanto gravava
    const agora = new Date().toISOString();
    for (const c of lote) {
      const valores = c.atual ? { ...(c.anterior ?? {}), ...c.atual } : c.anterior;
      const neg = c.atual ? { ...(c.negocios_anterior ?? {}), ...ciclo(c.atual) } : c.negocios_anterior;
      const { error: e2 } = await p.from("hubspot_contato_campos")
        .update({ sujo: false, valores, negocios_valores: neg, escrito_em: agora })
        .eq("hubspot_contact_id", c.hubspot_contact_id).eq("marcado_em", c.marcado_em);
      if (e2) throw new Error(`registrar campos do contato: ${e2.message}`);
    }
  }
  return { contatos, negocios };
}
