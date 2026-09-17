/**
 * Envia pro Google Chat um resumo de teste com os últimos N contatos não
 * encontrados no HubSpot, coletados durante o modo DRY_RUN — pra validar o
 * formato do alerta (nome, telefone, link pro chat) antes de confiar no
 * alerta automático de produção.
 *
 * Uso: npm run test:google-chat-alert -- --role=SDR --limit 5
 */
import Database from "better-sqlite3";
import { env } from "../src/config/env.js";
import { sendNotFoundContactsReport } from "../src/alerts/googleChat.js";
import { getAttendantRole, type AttendantRole } from "../src/config/team.js";

function argValue(name: string): string | undefined {
  const arg = process.argv.find((a) => a.startsWith(`--${name}`));
  if (!arg) return undefined;
  return arg.split("=")[1] ?? process.argv[process.argv.indexOf(arg) + 1];
}

const role = (argValue("role")?.toUpperCase() as AttendantRole | undefined) ?? "SDR";
if (role !== "SDR" && role !== "CLOSER") {
  console.error('Use --role=SDR ou --role=CLOSER');
  process.exit(1);
}

const limit = Number(argValue("limit") ?? "5");

const db = new Database(env.SQLITE_PATH, { readonly: true });

interface Row {
  lead_name: string | null;
  lead_phone: string;
  lead_uuid: string;
  attendant_email: string | null;
}

const rows = (
  db
    .prepare(
      `SELECT lead_name, lead_phone, lead_uuid, attendant_email, MAX(created_at) as created_at
       FROM dry_run_results
       WHERE contact_found = 0
       GROUP BY lead_phone
       ORDER BY created_at DESC`,
    )
    .all() as Row[]
)
  .filter((r) => getAttendantRole(r.attendant_email) === role)
  .slice(0, limit);

if (rows.length === 0) {
  console.log(`Nenhum contato não encontrado de ${role} registrado em dry_run_results ainda.`);
  process.exit(0);
}

console.log(`Enviando teste com ${rows.length} contato(s) não encontrado(s) pro espaço ${role}...`);
await sendNotFoundContactsReport(
  role,
  rows.map((r) => ({ leadName: r.lead_name ?? undefined, leadPhone: r.lead_phone, leadUuid: r.lead_uuid })),
);
console.log("Enviado.");
