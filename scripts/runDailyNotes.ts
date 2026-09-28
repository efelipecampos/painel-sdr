/**
 * Gera manualmente as notas diárias de um dia (o serviço já faz isso sozinho
 * de hora em hora, pro dia anterior). Útil pra gerar dias antigos depois do
 * backfill. Idempotente: pares (contato, dia) já gerados são pulados.
 *
 *   npm run daily-notes -- 2026-09-27
 *   npm run daily-notes -- 2026-09-20 2026-09-27   (intervalo, inclusivo)
 */
import { runDailyNotes } from "../src/jobs/dailyNotes.js";
import { isSupabaseConfigured } from "../src/supabase/client.js";

const [from, to = from] = process.argv.slice(2);
if (!from || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
  console.error("Uso: npm run daily-notes -- AAAA-MM-DD [AAAA-MM-DD]");
  process.exit(1);
}
if (!isSupabaseConfigured()) {
  console.error("Falta SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY no .env");
  process.exit(1);
}

const days: string[] = [];
for (let d = new Date(`${from}T12:00:00Z`); d <= new Date(`${to}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
  days.push(d.toISOString().slice(0, 10));
}

for (const day of days) {
  const result = await runDailyNotes(day);
  console.log(day, result);
}
