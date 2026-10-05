// Worker do painel: lê public.raw_events e monta o schema painel.
// Uso: npm start (fica rodando) | npm run once (processa o que estiver pendente e sai)
//      | npm run rebuild-all (recalcula todos os leads; usar depois de migration que muda o cálculo).
import { config } from "./config.js";
import { HubspotClient, syncLeads, syncOwners, syncStages } from "./hubspot/leads.js";
import { createDb, processBatch, rebuildAll, syncRoles } from "./processor.js";

const once = process.argv.includes("--once");
const rebuild = process.argv.includes("--rebuild-all");
const db = createDb();
const hubspot = config.hubspotToken ? new HubspotClient(config.hubspotToken) : null;
let lastHubspotSync = 0;

async function syncHubspot(force: boolean): Promise<void> {
  if (!hubspot) return;
  if (!force && Date.now() - lastHubspotSync < config.hubspotEveryMinutes * 60_000) return;
  const stages = await syncStages(db, hubspot);
  const owners = await syncOwners(db, hubspot);
  const leads = await syncLeads(db, hubspot);
  lastHubspotSync = Date.now();
  console.log(`[worker] HubSpot: ${stages} etapas, ${owners} donos, ${leads} Leads atualizados`);
}

async function drain(): Promise<void> {
  await syncRoles(db);
  for (;;) {
    const r = await processBatch(db);
    if (r.read) console.log(`[worker] lidos ${r.read} eventos (ignorados ${r.ignored}), ${r.leads} leads recalculados, cursor ${r.cursor}`);
    if (r.read < config.batchSize) return;
  }
}

if (rebuild) {
  console.log(`[worker] ${await rebuildAll(db)} leads recalculados`);
} else if (once) {
  await drain();
  await syncHubspot(true);
} else {
  console.log(`[worker] iniciado; lendo raw_events a cada ${config.pollSeconds}s`);
  for (;;) {
    try {
      await drain();
      await syncHubspot(false);
    } catch (err) {
      console.error("[worker] erro na rodada:", err instanceof Error ? err.message : err);
    }
    await new Promise((r) => setTimeout(r, config.pollSeconds * 1000));
  }
}
