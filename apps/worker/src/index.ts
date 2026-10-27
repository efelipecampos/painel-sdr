// Worker do painel: lê public.raw_events e monta o schema painel.
// Uso: npm start (fica rodando) | npm run once (processa o que estiver pendente e sai)
//      | --hubspot-desde AAAA-MM-DD (relê os Leads do HubSpot modificados desde a data e sai)
//      | npm run alerta-teste (manda uma mensagem de teste no Google Chat e sai)
//      | npm run rebuild-all (recalcula todos os leads; usar depois de migration que muda o cálculo).
import { Monitor, postToGoogleChat } from "./alerts.js";
import { config } from "./config.js";
import { HubspotClient, resetLeadsCursor, syncLeads, syncOwners, syncStages } from "./hubspot/leads.js";
import { syncMeetings } from "./hubspot/meetings.js";
import { alertaSemHubspot, sincronizarReunioesAgenda } from "./hubspot/reunioesAgenda.js";
import { marcarRespostas } from "./hubspot/respostas.js";
import { gravarCamposContato } from "./hubspot/contatos.js";
import { marcarDiaResposta } from "./hubspot/diaResposta.js";
import { processarTagsDescarte } from "./jornada/tagDescarte.js";
import { checkGoogle } from "./google.js";
import { GoogleCalendar, accessToken, decryptToken } from "@painel/shared/google";
import { rodarJornada, syncTemplates } from "./jornada/motor.js";
import { PoliApi } from "@painel/shared/poli";
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
/** Reuniões no HubSpot (2026-10-27): a do Calendar é a oficial; liga e lê o status a cada 5 min, alerta a cada 30. */
let lastAgenda = 0;
/** Agenda do closer para liberar o horário de reunião cancelada no HubSpot (sem Google configurado: não mexe). */
const calendarDe = async (closerId: string): Promise<GoogleCalendar | null> => {
  if (!config.google) return null;
  const { data } = await db.schema("painel").from("google_connections").select("refresh_token_enc").eq("closer_id", closerId).maybeSingle();
  if (!data) return null;
  return new GoogleCalendar(await accessToken(config.google, decryptToken(data.refresh_token_enc, config.google.tokenKey)));
};
let lastAlertaAgenda = 0;
async function syncHubspotMeetings(): Promise<void> {
  // pedidos de troca de closer que passaram do prazo (2 h antes da reunião) expiram
  const { data: expirados } = await db.schema("painel").rpc("expirar_pedidos_troca");
  if (expirados) console.log(`[worker] ${expirados} pedidos de troca de closer expirados`);
  if (!hubspot) return;
  const r = await syncMeetings(db, hubspot);
  if (r.atualizadas || r.erros) console.log(`[worker] HubSpot reuniões antigas do painel: ${r.atualizadas} atualizadas, ${r.erros} com erro`);
  if (Date.now() - lastAgenda < 5 * 60_000) return;
  lastAgenda = Date.now();
  const g = await sincronizarReunioesAgenda(db, hubspot, calendarDe);
  if (g.ligadas || g.status || g.liberadas || g.erros) console.log(`[worker] HubSpot reuniões do Calendar: ${g.ligadas} ligadas, ${g.status} status atualizados, ${g.liberadas} horários liberados/retomados no Google, ${g.erros} com erro`);
  if (Date.now() - lastAlertaAgenda < 30 * 60_000) return;
  const { data: comercial } = await db.schema("painel").rpc("is_business_time", { p_at: new Date().toISOString() });
  if (!comercial) return;
  lastAlertaAgenda = Date.now();
  const texto = await alertaSemHubspot(db);
  if (texto) await postToGoogleChat(texto);
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

// "Respondeu template" no Lead (follow-up do n8n, 2026-10-09). Só às 08:50 e às 13:50 (decisão do Felipe, 2026-10-20):
// o n8n dispara às 09:00 e às 14:00, e rodar a cada rodada do worker ocupava 38% do banco. A rodada que falha ou
// que não termina (mais de 50 lotes) tenta de novo na rodada seguinte; deploy não dispara rodada.
const RESPONDEU_LOTES = 50;
let ultimoRespondeu = currentSlot(new Date(), config.respondeuTimes);
const syncRespostas = tarefaHubspot("Respondeu template", 'marcar "Respondeu template" nos Leads do HubSpot (o follow-up do n8n pode mandar mensagem para quem já respondeu)',
  async () => {
    const slot = currentSlot(new Date(), config.respondeuTimes);
    if (!slot || slot === ultimoRespondeu) return null;
    const n = await marcarRespostas(db, hubspot!, RESPONDEU_LOTES);
    if (n < RESPONDEU_LOTES * 100) ultimoRespondeu = slot;
    return `${n} Leads marcados como "Respondeu template" (rodada das ${slot.slice(11)})`;
  });
// Campos "Poli - ..." do Contato e dos Negócios abertos (2026-10-09; antes eram da integração)
const syncCamposContato = tarefaHubspot("campos do contato", 'gravar os campos "Poli - ..." dos Contatos e Negócios no HubSpot',
  async () => { const r = await gravarCamposContato(db, hubspot!); return r.contatos || r.negocios ? `campos atualizados em ${r.contatos} contatos e ${r.negocios} negócios` : null; });
// "Respondeu algum dia de prospecção?" no Lead (2026-10-26): a cada 15 min, como o sync dos Leads, que traz a etapa.
const DIA_MINUTOS = 15;
let ultimoDia = 0;
const syncDiaResposta = tarefaHubspot("dia da resposta", 'marcar "Respondeu algum dia de prospecção?" nos Leads do HubSpot',
  async () => {
    if (Date.now() - ultimoDia < DIA_MINUTOS * 60_000) return null;
    const n = await marcarDiaResposta(db, hubspot!, 20);
    ultimoDia = Date.now();
    return n ? `${n} Leads com o dia da resposta marcado` : null;
  });
// Descarte do Lead no HubSpot por tag "Descarte - ..." da Poli (2026-10-27).
const syncTagsDescarte = tarefaHubspot("descarte por tag", "descartar no HubSpot os Leads com tag de descarte da Poli",
  async () => { const n = await processarTagsDescarte(db, hubspot!); return n ? `${n} Leads descartados por tag da Poli` : null; });

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

// Jornada configurável (Fase 11): templates do Poli a cada 30 min e cliques a cada rodada, depois do processamento.
const poli = config.poli ? new PoliApi(config.poli.baseUrl, config.poli.token) : null;
async function jornada(): Promise<void> {
  if (!poli || !config.poli) return;
  const t = await syncTemplates(db, poli, config.poli);
  if (t) console.log(`[worker] jornada: ${t} templates do Poli atualizados`);
  const r = await rodarJornada(db, poli, config.poli, hubspot);
  if (r.cliques) console.log(`[worker] jornada: ${r.cliques} cliques com regra, ${r.enviados} enviados, ${r.falhas} falhas, ${r.pulados} pulados`);
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
    await syncDiaResposta();
    await syncTagsDescarte();
    try {
      await syncGoogle();
    } catch (err) {
      console.error("[worker] erro na conferência do Google:", err instanceof Error ? err.message : err);
    }
    try {
      await jornada();
    } catch (err) {
      console.error("[worker] erro na jornada:", err instanceof Error ? err.message : err);
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
