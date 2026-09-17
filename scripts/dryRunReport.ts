/**
 * Imprime uma tabela de conferência com os resultados do modo DRY_RUN:
 * últimas N mensagens avaliadas e a qual contato do HubSpot cada uma bateu
 * (ou não). Não escreve nada — só lê o SQLite local.
 *
 * Uso: npm run dry-run-report -- --limit 20
 */
import Database from "better-sqlite3";
import { env } from "../src/config/env.js";

const limitArg = process.argv.find((arg) => arg.startsWith("--limit"));
const limit = limitArg ? Number(limitArg.split("=")[1] ?? process.argv[process.argv.indexOf(limitArg) + 1]) : 20;

const db = new Database(env.SQLITE_PATH, { readonly: true });

interface Row {
  external_message_id: string;
  direction: string;
  lead_name: string | null;
  lead_phone: string;
  message_preview: string;
  attendant_email: string | null;
  contact_found: number;
  contact_id: string | null;
  matched_via: string | null;
  created_at: number;
}

const rows = db
  .prepare("SELECT * FROM dry_run_results ORDER BY created_at DESC LIMIT ?")
  .all(limit) as Row[];

console.log(`\nÚltimas ${rows.length} mensagens avaliadas em dry-run:\n`);
console.table(
  rows.map((r) => ({
    quando: new Date(r.created_at).toISOString(),
    direcao: r.direction,
    lead: r.lead_name ?? "(sem nome)",
    telefone: r.lead_phone,
    atendente: r.attendant_email ?? "-",
    contato_hubspot: r.contact_found ? `${r.contact_id} (${r.matched_via})` : "NÃO ENCONTRADO",
    mensagem: r.message_preview,
  })),
);

const notFound = rows.filter((r) => !r.contact_found).slice(0, 5);
console.log(`\nÚltimos ${notFound.length} não encontrados no HubSpot:\n`);
console.table(
  notFound.map((r) => ({
    lead: r.lead_name ?? "(sem nome)",
    telefone: r.lead_phone,
    atendente: r.attendant_email ?? "-",
  })),
);
