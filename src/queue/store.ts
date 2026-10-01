import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { env } from "../config/env.js";

/**
 * Persistência local só para confiabilidade do webhook — dedupe de mensagens
 * reentregues pela Poli e retry se o HubSpot estiver indisponível. Não é um
 * banco de analytics (decisão do usuário: análises ficam no HubSpot nativo).
 */

mkdirSync(dirname(env.SQLITE_PATH), { recursive: true });
const db = new Database(env.SQLITE_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS processed_messages (
    external_message_id TEXT PRIMARY KEY,
    processed_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS failed_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    external_message_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    last_error TEXT,
    attempts INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    last_attempt_at INTEGER NOT NULL
  );

  -- Eventos crus que falharam ao gravar no Supabase (painel de SDR), com
  -- retry próprio — a fila failed_jobs reprocessa no HubSpot, que não é o
  -- caso aqui.
  CREATE TABLE IF NOT EXISTS raw_event_jobs (
    external_id TEXT PRIMARY KEY,
    event_type TEXT,
    payload TEXT NOT NULL,
    last_error TEXT,
    attempts INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    last_attempt_at INTEGER NOT NULL
  );

  -- Índice local dos atendimentos que já têm evento gravado, pra decidir a
  -- regra de saída do chat sem consultar o Supabase toda vez.
  CREATE TABLE IF NOT EXISTS raw_event_attendances (
    attendance_uuid TEXT PRIMARY KEY,
    first_seen_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS daily_notes (
    contact_id TEXT NOT NULL,
    day TEXT NOT NULL,
    note_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (contact_id, day)
  );

  CREATE TABLE IF NOT EXISTS dry_run_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    external_message_id TEXT NOT NULL,
    direction TEXT NOT NULL,
    lead_name TEXT,
    lead_phone TEXT NOT NULL,
    lead_uuid TEXT,
    message_preview TEXT,
    attendant_email TEXT,
    contact_found INTEGER NOT NULL,
    contact_id TEXT,
    created_at INTEGER NOT NULL
  );
`);

// Migração leve pra bancos criados antes de campos serem adicionados.
const dryRunColumns = db.prepare("PRAGMA table_info(dry_run_results)").all() as Array<{ name: string }>;
const addDryRunColumnIfMissing = (name: string, ddl: string) => {
  if (!dryRunColumns.some((c) => c.name === name)) {
    db.exec(`ALTER TABLE dry_run_results ADD COLUMN ${ddl}`);
  }
};
addDryRunColumnIfMissing("lead_uuid", "lead_uuid TEXT");
addDryRunColumnIfMissing("is_template", "is_template INTEGER");
addDryRunColumnIfMissing("template_name", "template_name TEXT");
addDryRunColumnIfMissing("matched_via", "matched_via TEXT");

export function isAlreadyProcessed(externalMessageId: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM processed_messages WHERE external_message_id = ?")
    .get(externalMessageId);
  return row !== undefined;
}

export function markProcessed(externalMessageId: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO processed_messages (external_message_id, processed_at) VALUES (?, ?)",
  ).run(externalMessageId, Date.now());
}

export function recordFailure(externalMessageId: string, payload: unknown, error: string): void {
  const existing = db
    .prepare("SELECT id, attempts FROM failed_jobs WHERE external_message_id = ?")
    .get(externalMessageId) as { id: number; attempts: number } | undefined;

  if (existing) {
    db.prepare(
      "UPDATE failed_jobs SET attempts = ?, last_error = ?, last_attempt_at = ? WHERE id = ?",
    ).run(existing.attempts + 1, error, Date.now(), existing.id);
    return;
  }

  db.prepare(
    `INSERT INTO failed_jobs (external_message_id, payload, last_error, attempts, created_at, last_attempt_at)
     VALUES (?, ?, ?, 1, ?, ?)`,
  ).run(externalMessageId, JSON.stringify(payload), error, Date.now(), Date.now());
}

export function clearFailure(externalMessageId: string): void {
  db.prepare("DELETE FROM failed_jobs WHERE external_message_id = ?").run(externalMessageId);
}

export interface FailedJob {
  id: number;
  external_message_id: string;
  payload: string;
  attempts: number;
}

export function listFailedJobs(maxAttempts: number): FailedJob[] {
  return db
    .prepare("SELECT id, external_message_id, payload, attempts FROM failed_jobs WHERE attempts <= ?")
    .all(maxAttempts) as FailedJob[];
}

export interface DryRunResultInput {
  externalMessageId: string;
  direction: "IN" | "OUT";
  leadName?: string;
  leadPhone: string;
  leadUuid: string;
  messagePreview: string;
  attendantEmail?: string;
  contactId: string | null;
  isTemplate: boolean;
  templateName?: string;
  matchedVia?: string;
}

export function recordDryRunResult(result: DryRunResultInput): void {
  db.prepare(
    `INSERT INTO dry_run_results
       (external_message_id, direction, lead_name, lead_phone, lead_uuid, message_preview, attendant_email, contact_found, contact_id, is_template, template_name, matched_via, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    result.externalMessageId,
    result.direction,
    result.leadName ?? null,
    result.leadPhone,
    result.leadUuid,
    result.messagePreview,
    result.attendantEmail ?? null,
    result.contactId ? 1 : 0,
    result.contactId,
    result.isTemplate ? 1 : 0,
    result.templateName ?? null,
    result.matchedVia ?? null,
    Date.now(),
  );
}

export interface TemplateDryRunResult {
  external_message_id: string;
  lead_name: string | null;
  lead_phone: string;
  template_name: string | null;
  created_at: number;
}

export function listTemplateMessages(limit: number): TemplateDryRunResult[] {
  return db
    .prepare(
      `SELECT external_message_id, lead_name, lead_phone, template_name, created_at
       FROM dry_run_results
       WHERE is_template = 1
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(limit) as TemplateDryRunResult[];
}

export interface NotFoundDryRunContact {
  lead_name: string | null;
  lead_phone: string;
  lead_uuid: string;
}

export function listLatestNotFoundContacts(limit: number): NotFoundDryRunContact[] {
  return db
    .prepare(
      `SELECT lead_name, lead_phone, lead_uuid, MAX(created_at) as created_at
       FROM dry_run_results
       WHERE contact_found = 0
       GROUP BY lead_phone
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(limit) as NotFoundDryRunContact[];
}

export function isDailyNoteDone(contactId: string, day: string): boolean {
  const row = db.prepare("SELECT 1 FROM daily_notes WHERE contact_id = ? AND day = ?").get(contactId, day);
  return row !== undefined;
}

export function markDailyNoteDone(contactId: string, day: string, noteId: string): void {
  db.prepare(
    "INSERT OR REPLACE INTO daily_notes (contact_id, day, note_id, created_at) VALUES (?, ?, ?, ?)",
  ).run(contactId, day, noteId, Date.now());
}

export function isRawEventAttendanceKnown(attendanceUuid: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM raw_event_attendances WHERE attendance_uuid = ?")
    .get(attendanceUuid);
  return row !== undefined;
}

export function markRawEventAttendance(attendanceUuid: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO raw_event_attendances (attendance_uuid, first_seen_at) VALUES (?, ?)",
  ).run(attendanceUuid, Date.now());
}

export function recordRawEventFailure(
  externalId: string,
  eventType: string | undefined,
  payload: unknown,
  error: string,
): void {
  const existing = db
    .prepare("SELECT attempts FROM raw_event_jobs WHERE external_id = ?")
    .get(externalId) as { attempts: number } | undefined;

  if (existing) {
    db.prepare(
      "UPDATE raw_event_jobs SET attempts = ?, last_error = ?, last_attempt_at = ? WHERE external_id = ?",
    ).run(existing.attempts + 1, error, Date.now(), externalId);
    return;
  }

  db.prepare(
    `INSERT INTO raw_event_jobs (external_id, event_type, payload, last_error, attempts, created_at, last_attempt_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)`,
  ).run(externalId, eventType ?? null, JSON.stringify(payload), error, Date.now(), Date.now());
}

export function clearRawEventJob(externalId: string): void {
  db.prepare("DELETE FROM raw_event_jobs WHERE external_id = ?").run(externalId);
}

export interface RawEventJob {
  external_id: string;
  event_type: string | null;
  payload: string;
  attempts: number;
}

export function listRawEventJobs(maxAttempts: number): RawEventJob[] {
  return db
    .prepare("SELECT external_id, event_type, payload, attempts FROM raw_event_jobs WHERE attempts <= ?")
    .all(maxAttempts) as RawEventJob[];
}
