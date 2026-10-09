// Worker do painel: lê public.raw_events e monta o schema painel.
// Uso: npm start (fica rodando) | npm run once (processa o que estiver pendente e sai)
//      | --hubspot-desde AAAA-MM-DD (relê os Leads do HubSpot modificados desde a data e sai)
//      | npm run alerta-teste (manda uma mensagem de teste no Google Chat e sai)
//      | npm run rebuild-all (recalcula todos os leads; usar depois de migration que muda o cálculo).
import { Monitor, postToGoogleChat } from "./alerts.js";
import { config } from "./config.js";
import { HubspotClient, resetLeadsCursor, syncLeads, syncOwners, syncStages } from "./hubspot/leads.js";
import { dailyCheck, stuckMeetings, syncMeetings } from "./hubspot/meetings.js";
import { marcarRespostas } from "./hubspot/respostas.js";
import { gravarCamposContato } from "./hubspot/contatos.js";
import { checkGoogle } from "./google.js";
import { createDb, processBatch, rebuildAll, syncRoles } from "./processor.js";
import { scoreRound } from "./score/job.js";
import { scorerFromEnv } from "./score/model.js";
import { currentSlot } from "./score/schedule.js";

const once = process.argv.includes("--once");
const rebuild = process.argv.includes("--rebuild-all");
const hubspotSince = (() => { const i = process.argv.indexOf("--hubspot-desde"); return i > 0 ? process.argv[i + 1] : null; })();
const db = createDb();
const hubspot = config.hubspotToken ? new HubspotClient(config.hubspotToken) : null;
let lastHubspotSync = 0;
let lastGoogleCheck = 0;
// Score de qualidade (Fase 7): de 2 em 2 horas, das 08:00 às 18:00 (decisão do Felipe, 08/10/2026; SCORE_HORARIOS),
// em paralelo com o resto do worker (a rodada leva minutos e não pode segurar a leitura dos eventos da Poli).
// Se o worker sobe no meio do intervalo, espera o próximo horário (deploy não dispara rodada).
// A IA vem de SCORE_IA (anthropic ou celeris); sem a chave dela no .env, o score não roda.
const scorer = scorerFromEnv();
let lastScoreSlot = currentSlot(new Date(), config.scoreTimes);
let scoreRunning = false;

function startScore(monitor: Monitor): void {
  if (!scorer || scoreRunning) return;
  const slot = currentSlot(new Date(), config.scoreTimes);
  if (!slot || slot === lastScoreSlot) return;
  lastScoreSlot = slot;
  scoreRunning = true;
  void (async () => {
    try {
      const r = await scoreRound(db, scorer, config.scoreMaxPerRound);
      console.log(`[worker] score (${scorer.model}): ${r.candidatos} candidatos, ${r.avaliados} avaliados, ${r.semNota} sem nota, ${r.erros} com erro, US$ ${r.custo.toFixed(3)}`);
      if (r.erros && r.erros === r.candidatos) throw new Error(`todas as ${r.erros} avaliações falharam`);
      await monitor.score(null);
    } catch (err) {
      console.error("[worker] erro no score:", err instanceof Error ? err.message : err);
      await monitor.score(err);
    } finally {
      scoreRunning = false;
    }
  })();
}

async function syncGoogle(): Promise<void> {
  if (!config.google || Date.now() - lastGoogleCheck < config.googleEveryMinutes * 60_000) return;
  lastGoogleCheck = Date.now();
  const r = await checkGoogle(db);
  console.log(`[worker] Google: ${r.conectadas} agendas ok, ${r.desconectadas} desconectadas, ${r.eventos} eventos conferidos, ${r.avisos} avisos`);
}

/** Devolve false quando não era hora de sincronizar. */
/** Reuniões do painel no HubSpot: cria/atualiza a cada rodada; status uma vez por dia (17:55). */
async function syncHubspotMeetings(): Promise<void> {
  // pedidos de troca de closer que passaram do prazo (2 h antes da reunião) expiram
  const { data: expirados } = await db.schema("painel").rpc("expirar_pedidos_troca");
  if (expirados) console.log(`[worker] ${expirados} pedidos de troca de closer expirados`);
  if (!hubspot) return;
  const r = await syncMeetings(db, hubspot);
  if (r.criadas || r.atualizadas || r.erros) console.log(`[worker] HubSpot reuniões: ${r.criadas} criadas, ${r.atualizadas} atualizadas, ${r.erros} com erro`);
  for (const m of await stuckMeetings(db)) {
    await postToGoogleChat(`⚠️ *Painel SDR:* a reunião "${m.title ?? "sem título"}" não foi gravada no HubSpot há mais de 15 min. Erro: ${m.error ?? "—"}. O painel continua tentando.`);
  }
  const d = await dailyCheck(db, hubspot);
  if (d) {
    console.log(`[worker] HubSpot 17:55: ${d.conferidas} conferidas, ${d.corrigidas} corrigidas, ${d.recriadas} recriadas, ${d.duplicadas.length} possíveis duplicadas`);
    await postToGoogleChat(`📋 *HubSpot, conferência das 17:55* (reuniões do painel dos últimos 5 dias)\n${d.conferidas} conferidas · ${d.corrigidas} corrigidas · ${d.recriadas} recriadas (tinham sido apagadas)`
      + (d.duplicadas.length ? `\n⚠️ Possível reunião duplicada no HubSpot (outra reunião do mesmo contato no mesmo dia, criada fora do painel):\n${d.duplicadas.map((x) => `• ${x}`).join("\n")}` : "\nNenhuma reunião duplicada encontrada."));
  }
}

/** Tarefa que grava no HubSpot a cada rodada; alerta no Gestão SDR se falhar por mais de 15 min seguidos. */
function tarefaHubspot(nome: string, aviso: string, fn: () => Promise<string | null>): () => Promise<void> {
  let erroDesde = 0;
  let alertou = false;
  return async () => {
    if (!hubspot) return;
    try {
      const log = await fn();
      if (log) console.log(`[worker] HubSpot: ${log}`);
      erroDesde = 0;
      alertou = false;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[worker] erro em ${nome}:`, msg);
      erroDesde ||= Date.now();
      if (!alertou && Date.now() - erroDesde > 15 * 60_000) {
        alertou = true;
        await postToGoogleChat(`⚠️ *Painel SDR:* há mais de 15 min o painel não consegue ${aviso}. Erro: ${msg}. O painel continua tentando.`);
      }
    }
  };
}

// "Respondeu template" no Lead (follow-up do n8n, 2026-10-09)
const syncRespostas = tarefaHubspot("Respondeu template", 'marcar "Respondeu template" nos Leads do HubSpot (o follow-up do n8n pode mandar mensagem para quem já respondeu)',
  async () => { const n = await marcarRespostas(db, hubspot!); return n ? `${n} Leads marcados como "Respondeu template"` : null; });
// Campos "Poli - ..." do Contato e dos Negócios abertos (2026-10-09; antes eram da integração)
const syncCamposContato = tarefaHubspot("campos do contato", 'gravar os campos "Poli - ..." dos Contatos e Negócios no HubSpot',
  async () => { const r = await gravarCamposContato(db, hubspot!); return r.contatos || r.negocios ? `campos atualizados em ${r.contatos} contatos e ${r.negocios} negócios` : null; });

async function syncHubspot(force: boolean): Promise<boolean> {
  if (!hubspot) return false;
  if (!force && Date.now() - lastHubspotSync < config.hubspotEveryMinutes * 60_000) return false;
  const stages = await syncStages(db, hubspot);
  const owners = await syncOwners(db, hubspot);
  const leads = await syncLeads(db, hubspot);
  lastHubspotSync = Date.now();
  console.log(`[worker] HubSpot: ${stages} etapas, ${owners} donos, ${leads} Leads atualizados`);
  return true;
}

async function drain(): Promise<void> {
  await syncRoles(db);
  for (;;) {
    const r = await processBatch(db);
    if (r.read) console.log(`[worker] lidos ${r.read} eventos (ignorados ${r.ignored}), ${r.leads} leads recalculados, cursor ${r.cursor}`);
    if (r.read < config.batchSize) return;
  }
}

if (process.argv.includes("--testar-alerta")) {
  const ok = await postToGoogleChat("🧪 *Painel SDR:* teste de alerta. Se você está vendo isto, os alertas do painel chegam neste espaço.");
  console.log(ok ? "[alertas] teste enviado" : "[alertas] teste NÃO enviado");
  process.exit(ok ? 0 : 1);
} else if (hubspotSince) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(hubspotSince)) throw new Error("Use --hubspot-desde AAAA-MM-DD");
  await resetLeadsCursor(db, hubspotSince);
  await syncHubspot(true);
} else if (rebuild) {
  console.log(`[worker] ${await rebuildAll(db)} leads recalculados`);
} else if (once) {
  await drain();
  await syncHubspot(true);
} else {
  console.log(`[worker] iniciado; lendo raw_events a cada ${config.pollSeconds}s`);
  const monitor = new Monitor(db);
  for (;;) {
    try {
      await drain();
      await monitor.worker(null);
    } catch (err) {
      console.error("[worker] erro na rodada:", err instanceof Error ? err.message : err);
      await monitor.worker(err);
    }
    try {
      if (await syncHubspot(false)) await monitor.hubspot(null);
    } catch (err) {
      console.error("[worker] erro no sync do HubSpot:", err instanceof Error ? err.message : err);
      await monitor.hubspot(err);
    }
    await syncRespostas();
    await syncCamposContato();
    try {
      await syncGoogle();
    } catch (err) {
      console.error("[worker] erro na conferência do Google:", err instanceof Error ? err.message : err);
    }
    try {
      await syncHubspotMeetings();
    } catch (err) {
      console.error("[worker] erro nas reuniões do HubSpot:", err instanceof Error ? err.message : err);
    }
    startScore(monitor);
    await monitor.check();
    await new Promise((r) => setTimeout(r, config.pollSeconds * 1000));
  }
}
