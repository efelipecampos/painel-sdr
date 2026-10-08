// Modo teste do score (Fase 7): avalia N leads reais e mostra notas, justificativas e custo. NÃO grava nada.
// Uso: npm run score-teste -w @painel/worker [-- 20]
// Pega os leads que escreveram nos últimos 7 dias, estão parados há 1 h ou mais, têm SDR (não closer nem robô) como
// responsável e 2+ mensagens escritas por eles; até 2 por SDR, para variar.
// A saída mostra o número curto do lead e o nome do SDR (sem telefone nem texto de mensagem do lead).
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { createDb } from "../processor.js";
import { scoreConversation } from "./model.js";
import {
  buildTranscript, criteriaVersion, DEFAULT_CONTEXT, DEFAULT_CRITERIA, leadMessageCount, MIN_LEAD_MESSAGES, type TranscriptMessage,
} from "./rules.js";

const n = Number(process.argv[2] ?? 20);
if (!config.anthropicModel) throw new Error("Defina ANTHROPIC_MODEL no .env (ex.: claude-haiku-4-5).");
if (!process.env.ANTHROPIC_API_KEY?.trim()) throw new Error("Defina ANTHROPIC_API_KEY no .env.");

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

// 2. Avalia um por um.
const client = new Anthropic();
const names = DEFAULT_CRITERIA.map((c) => c.name);
console.log(`Modelo ${config.anthropicModel} · critérios versão ${criteriaVersion(DEFAULT_CONTEXT, DEFAULT_CRITERIA)} · ${picked.length} leads\n`);
let total = 0;
let ok = 0;
const scores: number[] = [];
for (const [i, leadId] of picked.entries()) {
  const msgs = convs.get(leadId)!;
  const fromLead = leadMessageCount(msgs);
  const sdr = sdrs.get(lastByLead.get(leadId)?.sdr_id ?? "") ?? "sem SDR";
  const head = `#${i + 1} lead ${leadId.slice(0, 8)} · ${sdr} · ${msgs.length} mensagens (${fromLead} escritas pelo lead) · HubSpot: ${await hubspotStage(contactOf.get(leadId) ?? null)}`;
  try {
    const r = await scoreConversation(client, config.anthropicModel, DEFAULT_CONTEXT, DEFAULT_CRITERIA, buildTranscript(msgs));
    total += r.cost;
    ok++;
    if (r.score !== null) scores.push(r.score);
    console.log(`${head}\n   NOTA ${r.existingCustomer ? "sem nota (já é cliente)" : r.score ?? "sem informação"} — ${r.summary}`);
    r.criteria_scores.forEach((c, j) => console.log(`   ${names[j]}: ${c.score ?? "sem informação"} — ${c.justificativa}`));
    console.log(`   tokens: ${r.usage.input_tokens} entrada, ${r.usage.output_tokens} saída · US$ ${r.cost.toFixed(4)}\n`);
  } catch (err) {
    console.log(`${head}\n   ERRO: ${err instanceof Error ? err.message : err}\n`);
  }
}

// 3. Custo.
const per = ok ? total / ok : 0;
console.log(`Ficaram de fora pelo corte (menos de ${MIN_LEAD_MESSAGES} mensagens escritas pelo lead): ${belowCut} leads olhados até achar os ${picked.length}`);
console.log(`Avaliados: ${ok} de ${picked.length} · custo do teste US$ ${total.toFixed(4)} · média US$ ${per.toFixed(4)} por lead`);
if (scores.length) console.log(`Notas: menor ${Math.min(...scores)}, maior ${Math.max(...scores)}, média ${Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)}`);
for (const perDay of [156, 250]) console.log(`Projeção com ${perDay} avaliações/dia: US$ ${(per * perDay * 30).toFixed(2)} por mês`);
