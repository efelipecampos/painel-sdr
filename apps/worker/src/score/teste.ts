// Modo teste do score (Fase 7): avalia N leads reais e mostra notas, justificativas e custo. NÃO grava nada.
// Uso: npm run score-teste -w @painel/worker [-- 20] [--ia anthropic|celeris|ambas]
// Sem --ia, usa a IA de SCORE_IA. Com "ambas", avalia os mesmos leads nas duas e mostra lado a lado.
// Usa os critérios e o contexto gravados no banco (tela de Configurações).
// Pega os leads que escreveram nos últimos 7 dias, estão parados há 1 h ou mais, têm SDR (não closer nem robô) como
// responsável e 2+ mensagens escritas por eles; até 2 por SDR, para variar.
// A saída mostra o número curto do lead e o nome do SDR (sem telefone nem texto de mensagem do lead).
import { createDb } from "../processor.js";
import { loadCriteria } from "./job.js";
import { scoreConversation, scorerFromEnv, type Scorer } from "./model.js";
import {
  buildTranscript, criteriaVersion, leadMessageCount, MIN_LEAD_MESSAGES, type TranscriptMessage,
} from "./rules.js";

const args = process.argv.slice(2);
const iaArg = (() => { const i = args.indexOf("--ia"); return i >= 0 ? args[i + 1] : null; })();
const n = Number(args.find((a) => /^\d+$/.test(a)) ?? 20);
const scorers: Scorer[] = (iaArg === "ambas" ? ["anthropic", "celeris"] : [iaArg ?? process.env.SCORE_IA ?? "anthropic"]).map((ia) => {
  const s = scorerFromEnv({ ...process.env, SCORE_IA: ia });
  if (!s) throw new Error(ia === "celeris" ? "Defina CELERIS_API_KEY no .env." : "Defina ANTHROPIC_API_KEY e ANTHROPIC_MODEL no .env.");
  return s;
});

const db = createDb();
const p = db.schema("painel");
const now = Date.now();

function check<T>(res: { data: T | null; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data as T;
}

// 1. Leads candidatos: última mensagem do lead nos últimos 7 dias e há 1 h ou mais.
const recent = check(await p.from("chat_messages").select("lead_id, sdr_id, sent_at")
  .eq("sender", "lead")
  .gte("sent_at", new Date(now - 7 * 86_400_000).toISOString())
  .order("sent_at", { ascending: false }).limit(5000), "ler mensagens") as { lead_id: string; sdr_id: string | null; sent_at: string }[];
const lastByLead = new Map<string, { sdr_id: string | null; sent_at: string }>();
for (const r of recent) if (!lastByLead.has(r.lead_id)) lastByLead.set(r.lead_id, r);

const sdrRows = check(await p.from("sdrs").select("id, name, role, is_bot"), "ler sdrs") as { id: string; name: string; role: string | null; is_bot: boolean }[];
const sdrs = new Map(sdrRows.map((s) => [s.id, s.name]));
const isSdr = new Set(sdrRows.filter((s) => s.role === "sdr" && !s.is_bot).map((s) => s.id));

async function conversation(leadId: string): Promise<TranscriptMessage[]> {
  return check(await p.from("chat_messages").select("sender, body, template_name, sent_at")
    .eq("lead_id", leadId).order("sent_at"), "ler conversa") as TranscriptMessage[];
}

const perSdr = new Map<string, number>();
const picked: string[] = [];
const convs = new Map<string, TranscriptMessage[]>();
let belowCut = 0;
for (const [lead, r] of lastByLead) {
  if (picked.length >= n) break;
  if (now - Date.parse(r.sent_at) < 3_600_000) continue;
  if (!r.sdr_id || !isSdr.has(r.sdr_id)) continue;
  if ((perSdr.get(r.sdr_id) ?? 0) >= 2) continue;
  const msgs = await conversation(lead);
  if (leadMessageCount(msgs) < MIN_LEAD_MESSAGES) { belowCut++; continue; }
  perSdr.set(r.sdr_id, (perSdr.get(r.sdr_id) ?? 0) + 1);
  picked.push(lead);
  convs.set(lead, msgs);
}
const leads = check(await p.from("leads").select("id, hubspot_contact_id").in("id", picked), "ler leads") as { id: string; hubspot_contact_id: string | null }[];
const contactOf = new Map(leads.map((l) => [l.id, l.hubspot_contact_id]));
const stages = new Map((check(await p.from("hubspot_stages").select("stage_id, label"), "ler etapas") as { stage_id: string; label: string }[]).map((s) => [s.stage_id, s.label]));

async function hubspotStage(contact: string | null): Promise<string> {
  if (!contact) return "sem contato no HubSpot";
  const rows = check(await p.from("hubspot_leads").select("stage_id, created_at").eq("hubspot_contact_id", contact)
    .order("created_at", { ascending: false }).limit(1), "ler Lead do HubSpot") as { stage_id: string | null }[];
  return rows.length ? stages.get(rows[0].stage_id ?? "") ?? "etapa desconhecida" : "sem Lead no HubSpot";
}

// 2. Avalia um por um, em cada IA.
const { context, criteria } = await loadCriteria(db);
const names = criteria.map((c) => c.name);
console.log(`${scorers.map((s) => s.model).join(" × ")} · critérios versão ${criteriaVersion(context, criteria)} · ${picked.length} leads\n`);
const tot = scorers.map(() => ({ custo: 0, ok: 0, notas: [] as number[] }));
const diffs: number[] = [];
for (const [i, leadId] of picked.entries()) {
  const msgs = convs.get(leadId)!;
  const fromLead = leadMessageCount(msgs);
  const sdr = sdrs.get(lastByLead.get(leadId)?.sdr_id ?? "") ?? "sem SDR";
  console.log(`#${i + 1} lead ${leadId.slice(0, 8)} · ${sdr} · ${msgs.length} mensagens (${fromLead} escritas pelo lead) · HubSpot: ${await hubspotStage(contactOf.get(leadId) ?? null)}`);
  const notas: (number | null)[] = [];
  for (const [j, scorer] of scorers.entries()) {
    try {
      const t0 = Date.now();
      const r = await scoreConversation(scorer, context, criteria, buildTranscript(msgs));
      tot[j].custo += r.cost;
      tot[j].ok++;
      if (r.score !== null) tot[j].notas.push(r.score);
      notas.push(r.score);
      console.log(`  [${scorer.model}] NOTA ${r.existingCustomer ? "sem nota (já é cliente)" : r.score ?? "sem informação"} — ${r.summary}`);
      r.criteria_scores.forEach((c, k) => console.log(`     ${names[k]}: ${c.score ?? "sem informação"} — ${c.justificativa}`));
      console.log(`     tokens: ${r.usage.input_tokens} entrada, ${r.usage.output_tokens} saída · US$ ${r.cost.toFixed(4)} · ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    } catch (err) {
      notas.push(null);
      console.log(`  [${scorer.model}] ERRO: ${err instanceof Error ? err.message : err}`);
    }
  }
  if (notas.length === 2 && notas[0] !== null && notas[1] !== null) diffs.push(Math.abs(notas[0] - notas[1]));
  console.log("");
}

// 3. Custo e comparação.
console.log(`Ficaram de fora pelo corte (menos de ${MIN_LEAD_MESSAGES} mensagens escritas pelo lead): ${belowCut} leads olhados até achar os ${picked.length}`);
for (const [j, scorer] of scorers.entries()) {
  const t = tot[j];
  const per = t.ok ? t.custo / t.ok : 0;
  const media = t.notas.length ? Math.round(t.notas.reduce((a, b) => a + b, 0) / t.notas.length) : null;
  console.log(`[${scorer.model}] avaliados ${t.ok} de ${picked.length} · custo US$ ${t.custo.toFixed(4)} · média US$ ${per.toFixed(5)} por lead · nota média ${media ?? "—"} · 300 leads/dia por 30 dias: US$ ${(per * 300 * 30).toFixed(2)}`);
}
if (diffs.length) {
  diffs.sort((a, b) => a - b);
  console.log(`Diferença entre as notas das duas IAs: mediana ${diffs[Math.floor(diffs.length / 2)]} pontos, maior ${diffs[diffs.length - 1]} · até 10 pontos em ${diffs.filter((d) => d <= 10).length} de ${diffs.length} leads`);
}
