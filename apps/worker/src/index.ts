// Worker do painel: lê public.raw_events e monta o schema painel.
// Uso: npm start (fica rodando) | npm run once (processa o que estiver pendente e sai).
import { config } from "./config.js";
import { createDb, processBatch, syncRoles } from "./processor.js";

const once = process.argv.includes("--once");
const db = createDb();

async function drain(): Promise<void> {
  await syncRoles(db);
  for (;;) {
    const r = await processBatch(db);
    if (r.read) console.log(`[worker] lidos ${r.read} eventos (ignorados ${r.ignored}), ${r.leads} leads recalculados, cursor ${r.cursor}`);
    if (r.read < config.batchSize) return;
  }
}

if (once) {
  await drain();
} else {
  console.log(`[worker] iniciado; lendo raw_events a cada ${config.pollSeconds}s`);
  for (;;) {
    try {
      await drain();
    } catch (err) {
      console.error("[worker] erro na rodada:", err instanceof Error ? err.message : err);
    }
    await new Promise((r) => setTimeout(r, config.pollSeconds * 1000));
  }
}
