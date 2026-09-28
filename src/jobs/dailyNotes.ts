import { createNote } from "../hubspot/notes.js";
import { listMessagesBetween, type DayMessage } from "../supabase/messages.js";
import { isSupabaseConfigured } from "../supabase/client.js";
import { isDailyNoteDone, markDailyNoteDone } from "../queue/store.js";
import { logger } from "../logger.js";

/**
 * Nota diária por contato com a conversa daquele dia. Existe porque a IA do
 * HubSpot lê Notes, mas não lê os registros de mensagem (Communications).
 *
 * O Brasil não tem mais horário de verão, então o dia é fechado com offset
 * fixo de -03:00 em vez de carregar base de fuso.
 */
const BRT_OFFSET = "-03:00";

/** Limite do corpo da nota no HubSpot (65.536) com folga pro aviso de corte. */
const MAX_NOTE_BODY = 60_000;

export function dayRange(day: string): { fromIso: string; toIso: string } {
  const from = new Date(`${day}T00:00:00${BRT_OFFSET}`);
  const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);
  return { fromIso: from.toISOString(), toIso: to.toISOString() };
}

/** Data (AAAA-MM-DD) no horário de Brasília, N dias atrás. */
export function brasiliaDay(nowMs: number, daysAgo = 0): string {
  const shifted = new Date(nowMs - 3 * 60 * 60 * 1000 - daysAgo * 24 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatTime(sentAt: string): string {
  const d = new Date(new Date(sentAt).getTime() - 3 * 60 * 60 * 1000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

function formatDay(day: string): string {
  const [year, month, dayOfMonth] = day.split("-");
  return `${dayOfMonth}/${month}/${year}`;
}

export function buildNoteBody(day: string, messages: DayMessage[]): string {
  const leadName = messages.find((m) => m.lead_name)?.lead_name ?? "lead";
  const lines = messages.map((m) => {
    const who =
      m.direction === "IN"
        ? `${leadName} (lead)`
        : `${m.attendant_name ?? "time"} (time)${m.template_name ? ` [template: ${m.template_name}]` : ""}`;
    const content = [m.media_description, m.text].filter(Boolean).join(" ") || "(mensagem sem texto)";
    return `<li>${formatTime(m.sent_at)} — <b>${escapeHtml(who)}</b>: ${escapeHtml(content)}</li>`;
  });

  const header = `<p><b>Conversa no WhatsApp (Poli) — ${formatDay(day)}</b><br>${messages.length} mensagem(ns).</p>`;
  let body = `${header}<ul>${lines.join("")}</ul>`;
  if (body.length > MAX_NOTE_BODY) {
    body = `${body.slice(0, MAX_NOTE_BODY)}…</ul><p><i>Conversa longa: parte das mensagens foi cortada nesta nota.</i></p>`;
  }
  return body;
}

function groupByContact(messages: DayMessage[]): Map<string, DayMessage[]> {
  const byContact = new Map<string, DayMessage[]>();
  for (const m of messages) {
    const list = byContact.get(m.hubspot_contact_id);
    if (list) list.push(m);
    else byContact.set(m.hubspot_contact_id, [m]);
  }
  return byContact;
}

/**
 * Gera as notas de um dia. Idempotente: cada par (contato, dia) só vira nota
 * uma vez, registrado no SQLite local.
 */
export async function runDailyNotes(day: string): Promise<{ created: number; skipped: number; failed: number }> {
  const { fromIso, toIso } = dayRange(day);
  const messages = await listMessagesBetween(fromIso, toIso);
  const byContact = groupByContact(messages);

  let created = 0;
  let skipped = 0;
  let failed = 0;

  for (const [contactId, contactMessages] of byContact) {
    if (isDailyNoteDone(contactId, day)) {
      skipped++;
      continue;
    }
    try {
      // Carimba a nota no fim do dia, pra ela aparecer na ordem certa da
      // timeline, depois das mensagens que ela resume.
      const noteId = await createNote({
        contactId,
        body: buildNoteBody(day, contactMessages),
        timestampMs: new Date(toIso).getTime() - 1000,
      });
      markDailyNoteDone(contactId, day, noteId);
      created++;
    } catch (err) {
      failed++;
      logger.warn({ err, contactId, day }, "Falha ao criar a nota diária do contato");
    }
  }

  logger.info({ day, contatos: byContact.size, created, skipped, failed }, "Notas diárias processadas");
  return { created, skipped, failed };
}

/**
 * Roda de hora em hora: depois das 00:30 (BRT), gera as notas do dia
 * anterior. Também cobre os 2 dias anteriores, pro caso de o serviço ter
 * ficado fora do ar na virada — pares já gerados são pulados.
 */
export async function runPendingDailyNotes(nowMs = Date.now()): Promise<void> {
  if (!isSupabaseConfigured()) return;

  const brasiliaHour = new Date(nowMs - 3 * 60 * 60 * 1000).getUTCHours();
  const brasiliaMinute = new Date(nowMs).getUTCMinutes();
  if (brasiliaHour === 0 && brasiliaMinute < 30) return;

  for (const daysAgo of [1, 2, 3]) {
    await runDailyNotes(brasiliaDay(nowMs, daysAgo));
  }
}
