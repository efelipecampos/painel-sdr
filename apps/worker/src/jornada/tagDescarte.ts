// Descarte do Lead no HubSpot por tag da Poli (decisão do Felipe, 2026-10-27). O SDR aplica no contato uma tag
// "Descarte - <motivo>"; a integração grava o evento "tag_linked" em raw_events e aqui o Lead é descartado com o motivo
// da tag (painel.settings.poli_tags_descarte), sem prefixo no nome e com a observação abaixo. Tirar a tag não desfaz.
// Lead já Descartado: troca o motivo e acrescenta a observação (descartado de novo por outro motivo).
// Cada evento fica registrado em painel.tag_descartes. Erro do HubSpot para a rodada e tenta de novo na próxima.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { HubspotClient } from "../hubspot/leads.js";
import { descartarNoHubspot } from "./descarte.js";
import { contatosPorTelefone } from "../hubspot/contatosTelefone.js";

const EVENTO = "contacts.contact.tag_linked";
const CURSOR = "tag_descarte_cursor";

type Tag = { uuid?: string; id?: string; name?: string; attributes?: { name?: string } };
type Contato = { uuid?: string; phone?: string; attributes?: { phone?: string } };
type Payload = {
  uuid?: string;
  value?: { contact?: Contato; tag?: Tag; tags?: Tag[]; timestamp?: string; data?: { contact?: Contato; tag?: Tag } };
};

/**
 * Contato, telefone e tag do evento. Formato visto até 12/11 em value.contact / value.tag; as alternativas cobrem o
 * evento vir com outro formato (2026-11-26: desde 13/11 nenhuma tag era reconhecida).
 */
export function lerEventoTag(payload: Payload): { contato: string | null; telefone: string | undefined; tagUuid: string; tagNome: string } {
  const v = payload.value ?? {};
  const c = v.contact ?? v.data?.contact;
  const t = v.tag ?? v.data?.tag ?? v.tags?.[0];
  return {
    contato: c?.uuid ?? payload.uuid ?? null,
    telefone: c?.attributes?.phone ?? c?.phone,
    tagUuid: t?.uuid ?? t?.id ?? "",
    tagNome: t?.attributes?.name ?? t?.name ?? "",
  };
}

/** Motivo da tag pelo uuid; se o uuid não estiver configurado (tag recriada na Poli), pelo nome já visto antes. */
async function motivoDaTag(db: SupabaseClient, mapa: Record<string, string>, uuid: string, nome: string): Promise<string | null> {
  if (mapa[uuid]) return mapa[uuid];
  if (!nome) return null;
  const r = check(await db.schema("painel").from("tag_descartes").select("motivo").eq("tag_nome", nome).not("motivo", "is", null)
    .order("processado_em", { ascending: false }).limit(1), "ler motivo pelo nome da tag") as { motivo: string }[];
  return r[0]?.motivo ?? null;
}

/** "Descartado via integração com Tag Poli. Tag: ... SDR do atendimento: ... Em dd/mm/aaaa hh:mm." */
export function observacaoTag(tag: string, sdr: string | null, em: Date): string {
  const quando = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(em).replace(",", "");
  return `Descartado via integração com Tag Poli. Tag: ${tag}.${sdr ? ` SDR do atendimento: ${sdr}.` : ""} Em ${quando}.`;
}

function check<T>(res: { data: T | null; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data as T;
}

/** Processa as tags de descarte novas. Devolve quantos Leads foram descartados nesta rodada. */
export async function processarTagsDescarte(db: SupabaseClient, hs: Pick<HubspotClient, "call">, max = 50): Promise<number> {
  const p = db.schema("painel");
  const cfg = check(await p.from("settings").select("key, value").in("key", [CURSOR, "poli_tags_descarte"]), "ler configuração das tags");
  const cursor = Number(cfg.find((r: { key: string }) => r.key === CURSOR)?.value ?? 0);
  const mapa = (cfg.find((r: { key: string }) => r.key === "poli_tags_descarte")?.value ?? {}) as Record<string, string>;

  // até onde ler: o último evento agora (o cursor anda mesmo sem tag nova, para a busca ficar curta)
  const ultimo = check(await db.from("raw_events").select("id").order("id", { ascending: false }).limit(1), "ler último evento");
  const ate = Number(ultimo[0]?.id ?? cursor);
  if (ate <= cursor) return 0;
  const eventos = check(await db.from("raw_events").select("id, payload, received_at")
    .eq("event_type", EVENTO).gt("id", cursor).lte("id", ate).order("id").limit(max), "ler tags de descarte") as
    { id: number; payload: Payload; received_at: string }[];

  let descartados = 0;
  let novoCursor = eventos.length === max ? cursor : ate;
  for (const ev of eventos) {
    const v = ev.payload.value ?? {};
    const { contato, telefone, tagUuid, tagNome } = lerEventoTag(ev.payload);
    const motivo = await motivoDaTag(db, mapa, tagUuid, tagNome);
    const em = new Date(v.timestamp && !Number.isNaN(Date.parse(v.timestamp)) ? v.timestamp : ev.received_at);

    const leads = contato
      ? check(await p.from("leads").select("id, hubspot_contact_id").eq("poli_contact_uuid", contato), "ler lead da tag") as { id: string; hubspot_contact_id: string | null }[]
      : [];
    const hubspotId = leads.find((l) => l.hubspot_contact_id)?.hubspot_contact_id ?? null;
    // o contato que o painel conhece e os outros do HubSpot com o mesmo telefone (contato duplicado, 2026-10-28)
    let contatos = [hubspotId].filter((c): c is string => !!c);
    try {
      contatos = [...new Set([...contatos, ...(await contatosPorTelefone(hs, telefone))])];
    } catch (e) {
      if (!contatos.length) throw e; // sem o contato conhecido, a busca é o único caminho: tenta na próxima rodada
    }
    const chat = leads.length
      ? check(await p.from("chats").select("sdr_id, sdrs(name)").in("lead_id", leads.map((l) => l.id)).not("sdr_id", "is", null)
          .order("opened_at", { ascending: false }).limit(1), "ler SDR do atendimento") as unknown as { sdr_id: string; sdrs: unknown }[]
      : [];
    const rel = chat[0]?.sdrs as { name?: string | null } | { name?: string | null }[] | null | undefined;
    const sdr = chat[0] ? { sdr_id: chat[0].sdr_id, nome: (Array.isArray(rel) ? rel[0]?.name : rel?.name) ?? null } : null;

    const resultado = !motivo ? "tag sem motivo configurado"
      : await descartarNoHubspot(hs, contatos, motivo, observacaoTag(tagNome, sdr?.nome ?? null, em), { prefixo: false, redescartar: true });
    if (resultado.startsWith("erro")) {
      novoCursor = ev.id - 1; // tenta este de novo na próxima rodada
      await gravarCursor(db, novoCursor);
      throw new Error(`descarte por tag: ${resultado}`);
    }
    check(await p.from("tag_descartes").upsert({
      raw_event_id: ev.id, poli_contact_uuid: contato, tag_uuid: tagUuid, tag_nome: tagNome, motivo,
      hubspot_contact_id: hubspotId, sdr_id: sdr?.sdr_id ?? null, aplicada_em: em.toISOString(), resultado,
    }, { onConflict: "raw_event_id", ignoreDuplicates: true }), "registrar descarte por tag");
    if (resultado === "descartado" || resultado === "motivo atualizado") descartados++;
    if (eventos.length === max) novoCursor = ev.id;
  }
  await gravarCursor(db, novoCursor);
  return descartados;
}

async function gravarCursor(db: SupabaseClient, id: number): Promise<void> {
  check(await db.schema("painel").from("settings").upsert({ key: CURSOR, value: id, updated_at: new Date().toISOString() }), "gravar cursor das tags");
}
