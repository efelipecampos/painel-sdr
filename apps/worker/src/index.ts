// Worker do painel: lê public.raw_events e monta o schema painel.
// Uso: npm start (fica rodando) | npm run once (processa o que estiver pendente e sai)
//      | --hubspot-desde AAAA-MM-DD (relê os Leads do HubSpot modificados desde a data e sai)
//      | npm run alerta-teste (manda uma mensagem de teste no Google Chat e sai)
//      | npm run rebuild-all (recalcula todos os leads; usar depois de migration que muda o cálculo).
import { Monitor, postToGoogleChat } from "./alerts.js";
import { config } from "./config.js";
import { HubspotClient, resetLeadsCursor, syncLeads, syncOwners, syncStages } from "./hubspot/leads.js";
import { dailyStatusRun, syncMeetings } from "./hubspot/meetings.js";
import { checkGoogle } from "./google.js";
import { createDb, processBatch, rebuildAll, syncRoles } from "./processor.js";

const once = process.argv.includes("--once");
const rebuild = process.argv.includes("--rebuild-all");
const hubspotSince = (() => { const i = process.argv.indexOf("--hubspot-desde"); return i > 0 ? process.argv[i + 1] : null; })();
const db = createDb();
const hubspot = config.hubspotToken ? new HubspotClient(config.hubspotToken) : null;
let lastHubspotSync = 0;
let lastGoogleCheck = 0;

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
  const n = await dailyStatusRun(db, hubspot);
  if (n !== null) console.log(`[worker] HubSpot: rodada diária de status, ${n} reuniões atualizadas`);
}

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
    await monitor.check();
    await new Promise((r) => setTimeout(r, config.pollSeconds * 1000));
  }
}
