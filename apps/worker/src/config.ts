// Configuração do worker. Em desenvolvimento lê o .env da raiz do repositório;
// em produção as variáveis vêm do docker compose.
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const rootEnv = resolve(import.meta.dirname, "../../../.env");
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Variável de ambiente ${name} não definida.`);
  return v;
}

function emailList(name: string): Set<string> {
  return new Set((process.env[name] ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean));
}

export type TeamRole = "sdr" | "closer" | "gestor";

export const config = {
  supabaseUrl: required("NEXT_PUBLIC_SUPABASE_URL"),
  serviceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
  sdrEmails: emailList("POLI_SDR_EMAILS"),
  closerEmails: emailList("POLI_CLOSER_EMAILS"),
  managerEmails: emailList("POLI_MANAGER_EMAILS"),
  /** Intervalo entre rodadas de leitura de raw_events. */
  pollSeconds: Number(process.env.WORKER_POLL_SECONDS ?? 30),
  /** Eventos por lote. */
  batchSize: Number(process.env.WORKER_BATCH_SIZE ?? 500),
};

export function roleFor(email: string | null): TeamRole | null {
  if (!email) return null;
  if (config.sdrEmails.has(email)) return "sdr";
  if (config.closerEmails.has(email)) return "closer";
  if (config.managerEmails.has(email)) return "gestor";
  return null;
}
