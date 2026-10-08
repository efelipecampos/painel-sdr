// Job do score (Fase 7b): de hora em hora, avalia os leads com mensagem nova e grava em painel.lead_scores.
// Critérios e contexto vêm do banco (tela de Configurações). Liga só com ANTHROPIC_MODEL e ANTHROPIC_API_KEY no .env.
// LGPD: o log só tem contagens e o id curto do lead; nunca texto de mensagem nem telefone.
import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { scoreConversation } from "./model.js";
import { buildTranscript, criteriaVersion, leadMessageCount, MIN_LEAD_MESSAGES, type Criterion, type TranscriptMessage } from "./rules.js";

function check<T>(res: { data: T | null; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data as T;
}

export interface ScoreRound { candidatos: number; avaliados: number; semNota: number; erros: number; custo: number }

export async function loadCriteria(db: SupabaseClient): Promise<{ context: string; criteria: Criterion[] }> {
  const p = db.schema("painel");
  const rows = check(await p.from("quality_criteria").select("id, name, description, weight").eq("active", true).order("sort"), "ler critérios") as Criterion[];
  const ctx = check(await p.from("settings").select("value").eq("key", "quality_context"), "ler contexto") as { value: string }[];
  if (!rows.length) throw new Error("nenhum critério de qualidade ativo");
  return { context: ctx[0]?.value ?? "", criteria: rows };
}

/** Uma rodada: até `limit` leads, um por vez (o volume é pequeno e evita estourar o limite da API). */
export async function scoreRound(db: SupabaseClient, client: Anthropic, model: string, limit: number): Promise<ScoreRound> {
  const p = db.schema("painel");
  const { context, criteria } = await loadCriteria(db);
  const version = criteriaVersion(context, criteria);
  const cands = check(await p.rpc("score_candidatos", { p_version: version, p_limit: limit, p_idle_minutes: 60 }), "buscar candidatos") as
    { lead_id: string; last_lead_message_at: string }[];
  const r: ScoreRound = { candidatos: cands.length, avaliados: 0, semNota: 0, erros: 0, custo: 0 };

  for (const c of cands) {
    try {
      const msgs = check(await p.from("chat_messages").select("sender, body, template_name, sent_at")
        .eq("lead_id", c.lead_id).order("sent_at"), "ler conversa") as TranscriptMessage[];
      const base = { lead_id: c.lead_id, criteria_version: version, based_on_message_at: c.last_lead_message_at };
      if (leadMessageCount(msgs) < MIN_LEAD_MESSAGES) {
        check(await p.from("lead_scores").insert({ ...base, status: "abaixo_do_corte", score: null, criteria_scores: [] }), "gravar nota");
        r.semNota++;
        continue;
      }
      const s = await scoreConversation(client, model, context, criteria, buildTranscript(msgs));
      const status = s.existingCustomer ? "ja_e_cliente" : s.score === null ? "sem_informacao" : "avaliado";
      check(await p.from("lead_scores").insert({
        ...base, status, score: status === "avaliado" ? s.score : null, criteria_scores: s.criteria_scores, summary: s.summary,
        model, input_tokens: s.usage.input_tokens, output_tokens: s.usage.output_tokens,
      }), "gravar nota");
      r.custo += s.cost;
      if (status === "avaliado") r.avaliados++; else r.semNota++;
    } catch (err) {
      r.erros++;
      console.error(`[score] lead ${c.lead_id.slice(0, 8)}: ${err instanceof Error ? err.message : err}`);
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) throw err;
    }
  }
  return r;
}
