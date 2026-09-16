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
`);

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
