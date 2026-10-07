// Worker do painel: lê public.raw_events e monta o schema painel.
// Uso: npm start (fica rodando) | npm run once (processa o que estiver pendente e sai)
//      | --hubspot-desde AAAA-MM-DD (relê os Leads do HubSpot modificados desde a data e sai)
//      | npm run rebuild-all (recalcula todos os leads; usar depois de migration que muda o cálculo).
import { Monitor } from "./alerts.js";
import { config } from "./config.js";
import { HubspotClient, resetLeadsCursor, syncLeads, syncOwners, syncStages } from "./hubspot/leads.js";
import { createDb, processBatch, rebuildAll, syncRoles } from "./processor.js";

const once = process.argv.includes("--once");
const rebuild = process.argv.includes("--rebuild-all");
const hubspotSince = (() => { const i = process.argv.indexOf("--hubspot-desde"); return i > 0 ? process.argv[i + 1] : null; })();
const db = createDb();
const hubspot = config.hubspotToken ? new HubspotClient(config.hubspotToken) : null;
let lastHubspotSync = 0;

/** Devolve false quando não era hora de sincronizar. */
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

if (hubspotSince) {
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
    await monitor.check();
    await new Promise((r) => setTimeout(r, config.pollSeconds * 1000));
  }
}
