// Motor da jornada configurável (Fase 11, docs/jornada.md). Roda a cada rodada do worker, depois do processamento
// dos eventos: olha os eventos recebidos desde o cursor, reconhece o clique num botão de template, acha a regra e
// envia o template de destino pela API do Poli. Regra em teste envia só para o telefone de teste.
// Travas: o mesmo clique não é processado duas vezes (índice único), a mesma regra não envia de verdade duas vezes ao
// mesmo lead com o mesmo template, não envia se alguém da equipe já escreveu depois do clique, e respeita a pausa geral e o limite diário.
// Logs e registros: só ids, situação e motivo. Nada de telefone nem texto de mensagem.
import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { botaoClicado, escolherRegra, JANELA_TEXTO_MS, montarTexto, preencher, type Regra } from "@painel/shared/jornada";
import { PoliApi, PoliError, type PoliTemplate } from "@painel/shared/poli";
import type { HubspotClient } from "../hubspot/leads.js";
import { descartarNoHubspot } from "./descarte.js";

const CURSOR_KEY = "journey_cursor";
const LOTE = 500;

export interface JornadaConfig {
  accountUuid: string;
  channelUuid: string;
  templatesEveryMinutes: number;
}

export interface Resumo {
  cliques: number;
  enviados: number;
  falhas: number;
  pulados: number;
}

let ultimoSyncTemplates = 0;

/** Atualiza painel.poli_templates com a listagem da API (a cada N minutos). */
export async function syncTemplates(db: SupabaseClient, poli: PoliApi, cfg: JornadaConfig, force = false): Promise<number> {
  if (!force && Date.now() - ultimoSyncTemplates < cfg.templatesEveryMinutes * 60_000) return 0;
  const ts = await poli.listTemplates(cfg.accountUuid);
  const now = new Date().toISOString();
  for (let i = 0; i < ts.length; i += 200) {
    const { error } = await db.schema("painel").from("poli_templates").upsert(
      ts.slice(i, i + 200).map((t) => ({ uuid: t.uuid, key: t.key, status: t.status, category: t.category, body: t.body, buttons: t.buttons.map((text) => ({ text })), meta_name: t.metaName, synced_at: now })),
    );
    if (error) throw new Error(`gravar templates do Poli: ${error.message}`);
  }
  ultimoSyncTemplates = Date.now();
  return ts.length;
}

export async function rodarJornada(db: SupabaseClient, poli: PoliApi, cfg: JornadaConfig, hubspot: HubspotClient | null = null): Promise<Resumo> {
  const p = db.schema("painel");
  const out: Resumo = { cliques: 0, enviados: 0, falhas: 0, pulados: 0 };

  // Cursor: na primeira vez começa do evento mais recente. A jornada nunca olha cliques de antes de existir.
  const { data: cur } = await p.from("settings").select("value").eq("key", CURSOR_KEY).maybeSingle();
  let cursor = Number(cur?.value ?? 0);
  if (!cursor) {
    const { data: ult } = await db.from("raw_events").select("id").order("id", { ascending: false }).limit(1).maybeSingle();
    await salvarCursor(db, Number(ult?.id ?? 0));
    return out;
  }

  // Só eventos que o processamento já transformou em mensagem (chat_messages); os mais novos ficam para a próxima rodada.
  const { data: proc } = await p.from("settings").select("value").eq("key", "raw_events_cursor").maybeSingle();
  const processado = Number(proc?.value ?? 0);
  if (processado <= cursor) return out;
  const { data: evs, error } = await db.from("raw_events")
    .select("id, received_at, contato:payload->value->contact->>uuid, texto:payload->value->components->body->>text, respondeu:payload->value->context->message->>uuid")
    .eq("event_type", "messages.message.received").gt("id", cursor).lte("id", processado).order("id").limit(LOTE);
  if (error) throw new Error(`ler cliques: ${error.message}`);
  if (!evs?.length) {
    await salvarCursor(db, processado);
    return out;
  }

  const { data: regrasRaw } = await p.from("journey_rules").select("id, origin_template_uuid, origin_button, janela, tipo, dest_template_uuid, texto, status, daily_limit, descartar, descarte_motivo, descarte_obs").neq("status", "pausada");
  const regras = (regrasRaw ?? []) as Regra[];
  if (!regras.length) {
    await salvarCursor(db, Number(evs[evs.length - 1].id));
    return out;
  }
  const origens = new Set(regras.map((r) => r.origin_template_uuid));
  const { data: conf } = await p.from("journey_config").select("paused, test_phone").single();
  const sdrs = new Map(((await p.from("sdrs").select("id, name, is_bot")).data ?? []).map((s) => [s.id, s]));
  const humano = (m: { sender: string; sdr_id: string | null }) => m.sender === "sdr" && !!m.sdr_id && !sdrs.get(m.sdr_id)?.is_bot;

  for (const ev of evs) {
    const evId = Number(ev.id);
    try {
      await processarClique();
    } finally {
      await salvarCursor(db, evId);
    }

    async function processarClique(): Promise<void> {
      if (!ev.contato) return;
      const { data: lead } = await p.from("leads").select("id, name, hubspot_contact_id").eq("poli_contact_uuid", ev.contato).maybeSingle();
      if (!lead) return;
      const { data: msgs } = await p.from("chat_messages").select("sender, sdr_id, raw_event_id, sent_at, auto_reply")
        .eq("lead_id", lead.id).order("sent_at", { ascending: true }).limit(2000);
      const ms = msgs ?? [];
      const iClique = ms.findIndex((m) => Number(m.raw_event_id) === evId);
      if (iClique < 0 || ms[iClique].sender !== "lead") return;
      // Template de origem: a mensagem que o lead respondeu (o WhatsApp manda no context); sem essa informação, o
      // último template antes do clique, desde que o clique seja a primeira mensagem do lead depois dele.
      type TplEv = { uuid: string | null; botoes: unknown; contato: string | null };
      type TplRaw = TplEv & { meta?: string | null; botoesEmb?: unknown };
      // Template embutido (envio feito pelo Poli, sem o campo template): acha o template pelo nome da Meta.
      const resolverEmbutido = async (r: TplRaw): Promise<TplEv | null> => {
        if (r.uuid) return { uuid: r.uuid, botoes: r.botoes, contato: r.contato };
        if (!r.meta) return null;
        const { data: t } = await p.from("poli_templates").select("uuid, buttons").eq("meta_name", r.meta).maybeSingle();
        if (!t) return null;
        return { uuid: t.uuid, botoes: ((t.buttons as { text: string }[]) ?? []).map((b) => ({ type: "reply", text: b.text })), contato: r.contato };
      };
      let tplEv: TplEv | null = null;
      if (ev.respondeu) {
        const { data } = await db.from("raw_events")
          .select("uuid:payload->value->template->>uuid, botoes:payload->value->template->message->buttons, contato:payload->value->contact->>uuid, meta:payload->value->components->>name, botoesEmb:payload->value->components->buttons")
          .eq("source", "poli_webhook").eq("external_id", ev.respondeu as string).maybeSingle();
        if (data && data.contato === ev.contato) tplEv = await resolverEmbutido(data as unknown as TplRaw);
      }
      if (!tplEv) {
        let iTpl = -1;
        for (let i = iClique - 1; i >= 0; i--) {
          if (ms[i].sender === "lead" && !ms[i].auto_reply) return; // resposta automática do lead não conta

          if (ms[i].sender === "template") { iTpl = i; break; }
        }
        if (iTpl < 0 || !ms[iTpl].raw_event_id) return;
        const { data } = await db.from("raw_events")
          .select("uuid:payload->value->template->>uuid, botoes:payload->value->template->message->buttons, meta:payload->value->components->>name, botoesEmb:payload->value->components->buttons")
          .eq("id", ms[iTpl].raw_event_id).maybeSingle();
        tplEv = data ? await resolverEmbutido({ ...(data as unknown as TplRaw), contato: ev.contato as string }) : null;
      }
      const tplUuid = tplEv?.uuid ?? null;
      if (!tplUuid || !origens.has(tplUuid)) return;
      const botoes = ((tplEv?.botoes as { type?: string; text?: string }[] | null) ?? []).filter((b) => b.type === "reply" && b.text).map((b) => b.text!);
      const botao = botaoClicado(ev.texto as string | null, botoes);
      if (!botao) return;
      const clicouEm = ms[iClique].sent_at as string;
      const { data: noExp } = await p.rpc("is_business_time", { p_at: clicouEm });
      const regra = escolherRegra(regras, tplUuid, botao, !!noExp);
      if (!regra) return;
      out.cliques++;

      const modo = regra.status === "teste" ? "teste" : "real";
      // O que foi enviado, para a trava "uma vez por lead": o template ou, para texto, o md5 do texto.
      const destino = regra.tipo === "texto" ? `texto:${createHash("md5").update(regra.texto ?? "").digest("hex")}` : regra.dest_template_uuid;
      const base = { rule_id: regra.id, click_event_id: evId, poli_contact_uuid: ev.contato as string, lead_id: lead.id, clicked_at: clicouEm, mode: modo, dest_template_uuid: destino };
      let descarte: string | null = null;
      const pular = async (reason: string, sdrId: string | null = null) => {
        const { error: e } = await p.from("journey_sends").upsert({ ...base, hubspot_descarte: descarte, sdr_id: sdrId, status: "pulado", reason }, { onConflict: "rule_id,click_event_id", ignoreDuplicates: true });
        if (e) throw new Error(`registrar envio pulado: ${e.message}`);
        out.pulados++;
      };

      if (conf?.paused) return pular("jornada_pausada");
      // Descarte no HubSpot (2026-10-16): vale mesmo que a mensagem não saia; regra em teste só registra.
      if (regra.descartar) {
        descarte = modo === "teste" ? "descartaria (teste)"
          : hubspot ? await descartarNoHubspot(hubspot, lead.hubspot_contact_id, regra.descarte_motivo ?? "", regra.descarte_obs ?? "")
          : "erro: sem acesso ao HubSpot";
      }
      if (modo === "teste" && !conf?.test_phone) return pular("sem_telefone_teste");
      if (ms.slice(iClique + 1).some(humano)) return pular("equipe_ja_escreveu");
      if (modo === "real") {
        const { count: ja } = await p.from("journey_sends").select("id", { count: "exact", head: true })
          .eq("rule_id", regra.id).eq("poli_contact_uuid", ev.contato).eq("dest_template_uuid", destino!).eq("mode", "real").eq("status", "enviado");
        if (ja) return pular("ja_enviado");
        if (regra.daily_limit) {
          const desde = new Date(Date.now() - 864e5).toISOString(); // 24 h corridas
          const { count: hoje } = await p.from("journey_sends").select("id", { count: "exact", head: true })
            .eq("rule_id", regra.id).eq("mode", "real").eq("status", "enviado").gte("created_at", desde);
          if ((hoje ?? 0) >= regra.daily_limit) {
            await pausarPorLimite(db, regra);
            return pular("limite_diario");
          }
        }
      }

      // Texto livre só sai com a janela de 24 h aberta (margem de 1 h).
      if (regra.tipo === "texto" && Date.now() - Date.parse(clicouEm) > JANELA_TEXTO_MS) return pular("janela_fechada");
      const sdr = await sdrDono(db, lead.hubspot_contact_id);
      const dados = { leadNome: lead.name as string | null, sdrNome: sdr?.name ?? null };
      let envio: { tipo: "template"; templateUuid: string; bodyParams: string[] } | { tipo: "texto"; texto: string };
      if (regra.tipo === "texto") {
        const t = montarTexto(regra.texto ?? "", dados);
        if (!t.ok) return pular(t.falta === "operator_name" ? "sem_sdr_dona" : `falta_${t.falta}`, sdr?.id ?? null);
        envio = { tipo: "texto", texto: t.texto };
      } else {
        const { data: dest } = await p.from("poli_templates").select("uuid, body").eq("uuid", regra.dest_template_uuid!).maybeSingle();
        if (!dest) return pular("template_nao_encontrado");
        const t = preencher(dest.body ?? "", dados);
        if (!t.ok) return pular(t.falta === "operator_name" ? "sem_sdr_dona" : `falta_${t.falta}`, sdr?.id ?? null);
        envio = { tipo: "template", templateUuid: dest.uuid as string, bodyParams: t.params };
      }

      // Reserva o clique antes de chamar o Poli: se o worker cair no meio, o mesmo clique não envia de novo.
      const { data: reserva, error: eRes } = await p.from("journey_sends")
        .upsert({ ...base, hubspot_descarte: descarte, sdr_id: sdr?.id ?? null, status: "falhou", reason: "enviando" }, { onConflict: "rule_id,click_event_id", ignoreDuplicates: true })
        .select("id");
      if (eRes) throw new Error(`reservar envio: ${eRes.message}`);
      if (!reserva?.length) return; // outro ciclo já tratou este clique

      try {
        const fone = String(conf?.test_phone ?? "");
        const msgUuid = envio.tipo === "texto"
          ? (modo === "teste" ? await poli.sendTextToPhone(cfg.accountUuid, fone, cfg.channelUuid, envio.texto)
                              : await poli.sendTextToContact(ev.contato as string, cfg.channelUuid, envio.texto))
          : (modo === "teste" ? await poli.sendToPhone(cfg.accountUuid, fone, { templateUuid: envio.templateUuid, channelUuid: cfg.channelUuid, bodyParams: envio.bodyParams })
                              : await poli.sendToContact(ev.contato as string, { templateUuid: envio.templateUuid, channelUuid: cfg.channelUuid, bodyParams: envio.bodyParams }));
        await p.from("journey_sends").update({ status: "enviado", reason: null, poli_message_uuid: msgUuid }).eq("id", reserva[0].id);
        out.enviados++;
      } catch (e) {
        const pe = e instanceof PoliError ? e : null;
        await p.from("journey_sends").update({ status: "falhou", reason: pe?.reason ?? "erro_interno", http_status: pe?.status ?? null }).eq("id", reserva[0].id);
        out.falhas++;
      }
    }
  }
  return out;
}

async function salvarCursor(db: SupabaseClient, id: number): Promise<void> {
  const { error } = await db.schema("painel").from("settings").upsert({ key: CURSOR_KEY, value: id, updated_at: new Date().toISOString() });
  if (error) throw new Error(`salvar cursor da jornada: ${error.message}`);
}

/** SDR dona do lead: dono do Lead mais recente no HubSpot, ligado ao atendente pelo e-mail. */
async function sdrDono(db: SupabaseClient, hubspotContactId: string | null): Promise<{ id: string; name: string } | null> {
  if (!hubspotContactId) return null;
  const p = db.schema("painel");
  const { data: hl } = await p.from("hubspot_leads").select("owner_id").eq("hubspot_contact_id", hubspotContactId)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!hl?.owner_id) return null;
  const { data: dono } = await p.from("hubspot_owners").select("email").eq("owner_id", hl.owner_id).maybeSingle();
  if (!dono?.email) return null;
  const { data: sdr } = await p.from("sdrs").select("id, name").ilike("poli_email", dono.email).maybeSingle();
  return sdr ? { id: sdr.id, name: sdr.name } : null;
}

/** Limite diário atingido: a regra pausa sozinha e o histórico registra (changed_by vazio = foi o worker). */
async function pausarPorLimite(db: SupabaseClient, r: Regra): Promise<void> {
  const p = db.schema("painel");
  const { data } = await p.from("journey_rules").update({ status: "pausada", paused_reason: "limite_diario" }).eq("id", r.id).eq("status", "ativa").select("id");
  if (data?.length) {
    await p.from("journey_rule_changes").insert({ rule_id: r.id, action: "pausou_limite", before: { status: "ativa" }, after: { status: "pausada", paused_reason: "limite_diario" } });
  }
}

export type { PoliTemplate };
