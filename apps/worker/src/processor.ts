// Processa public.raw_events em lotes, em ordem de id, e monta o schema painel.
// Idempotente: tudo é upsert por id externo, e o derivado (respostas, donos, estado do chat)
// é refeito do zero por lead em painel.rebuild_leads. Pode ser reexecutado a partir de qualquer cursor.
// LGPD: nunca loga texto de mensagem nem telefone.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config, roleFor } from "./config.js";
import { parsePoliEvent, toE164, type PoliEvent } from "./poli/event.js";

const CURSOR_KEY = "raw_events_cursor";
const IN_CHUNK = 100; // tamanho dos filtros "in (...)" para não estourar a URL

export function createDb(): SupabaseClient {
  return createClient(config.supabaseUrl, config.serviceRoleKey, { auth: { persistSession: false } });
}

function chunks<T>(list: T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function check<T>(res: { data: T | null; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data as T;
}

async function idMap(db: SupabaseClient, table: string, key: string, values: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const part of chunks([...new Set(values)])) {
    const rows = check(await db.schema("painel").from(table).select(`id, ${key}`).in(key, part), `buscar ${table}`) as unknown as Record<string, string>[];
    for (const r of rows) map.set(r[key], r.id);
  }
  return map;
}

export async function getCursor(db: SupabaseClient): Promise<number> {
  const rows = check(await db.schema("painel").from("settings").select("value").eq("key", CURSOR_KEY), "ler cursor");
  return rows.length ? Number(rows[0].value) : 0;
}

export async function setCursor(db: SupabaseClient, id: number): Promise<void> {
  check(await db.schema("painel").from("settings").upsert({ key: CURSOR_KEY, value: id, updated_at: new Date().toISOString() }), "gravar cursor");
}

/** Mantém o papel de cada atendente igual às listas do .env. */
export async function syncRoles(db: SupabaseClient): Promise<void> {
  const rows = check(await db.schema("painel").from("sdrs").select("id, poli_email, role"), "ler sdrs");
  for (const r of rows) {
    const role = roleFor(r.poli_email);
    if (role !== r.role) check(await db.schema("painel").from("sdrs").update({ role }).eq("id", r.id), "atualizar papel");
  }
}

/** Grava um conjunto de eventos já lidos. Devolve os ids dos leads afetados. */
export async function upsertEvents(db: SupabaseClient, events: (PoliEvent & { rawEventId: number })[]): Promise<string[]> {
  if (!events.length) return [];
  const p = db.schema("painel");

  // Atendentes: insere os novos; nome e papel de quem já existe não mudam aqui.
  const owners = new Map<string, NonNullable<PoliEvent["owner"]>>();
  for (const e of events) if (e.owner?.email) owners.set(e.owner.uuid, e.owner);
  if (owners.size) {
    check(await p.from("sdrs").upsert(
      [...owners.values()].map((o) => ({ poli_attendant_uuid: o.uuid, poli_email: o.email, email: o.email, name: o.name ?? o.email, role: roleFor(o.email) })),
      { onConflict: "poli_email", ignoreDuplicates: true },
    ), "gravar sdrs");
  }
  const sdrIds = await idMap(db, "sdrs", "poli_attendant_uuid", [...owners.keys()]);

  // Leads: nome e telefone ficam com o valor mais recente.
  const contacts = new Map<string, PoliEvent["contact"]>();
  for (const e of [...events].sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime())) contacts.set(e.contact.uuid, e.contact);
  check(await p.from("leads").upsert(
    [...contacts.values()].map((c) => ({ poli_contact_uuid: c.uuid, name: c.name, phone_e164: toE164(c.phone) })),
    { onConflict: "poli_contact_uuid" },
  ), "gravar leads");
  const leadIds = await idMap(db, "leads", "poli_contact_uuid", [...contacts.keys()]);

  // Chats: só cria; o estado é recalculado por rebuild_leads.
  const firstByAttendance = new Map<string, PoliEvent>();
  for (const e of events) {
    const cur = firstByAttendance.get(e.attendanceUuid);
    if (!cur || e.sentAt < cur.sentAt) firstByAttendance.set(e.attendanceUuid, e);
  }
  check(await p.from("chats").upsert(
    [...firstByAttendance.values()].map((e) => ({
      poli_attendance_uuid: e.attendanceUuid,
      lead_id: leadIds.get(e.contact.uuid),
      sdr_id: e.owner ? (sdrIds.get(e.owner.uuid) ?? null) : null,
      opened_at: e.sentAt.toISOString(),
    })),
    { onConflict: "poli_attendance_uuid", ignoreDuplicates: true },
  ), "gravar chats");
  const chatIds = await idMap(db, "chats", "poli_attendance_uuid", [...firstByAttendance.keys()]);

  // Mensagens: upsert completo (reprocessar o mesmo evento grava o mesmo resultado).
  const messages = new Map<string, Record<string, unknown>>();
  for (const e of events) {
    messages.set(e.messageId, {
      poli_message_id: e.messageId,
      raw_event_id: e.rawEventId,
      chat_id: chatIds.get(e.attendanceUuid),
      lead_id: leadIds.get(e.contact.uuid),
      sdr_id: e.owner ? (sdrIds.get(e.owner.uuid) ?? null) : null,
      sender: e.sender,
      template_name: e.templateName,
      body: e.body,
      sent_at: e.sentAt.toISOString(),
      direction: e.direction,
      author_poli_uuid: e.authorUuid,
      by_human: e.byHuman,
      message_type: e.messageType,
      system_type: e.systemType,
      attendance_status: e.attendanceStatus,
      attendance_type: e.attendanceType,
      closed_reason: e.closedReason,
      note_tag: e.noteTag,
    });
  }
  for (const part of chunks([...messages.values()], 500)) {
    check(await p.from("chat_messages").upsert(part, { onConflict: "poli_message_id" }), "gravar mensagens");
  }

  // Contato no HubSpot: vem da integração (public.messages), que já faz o matching.
  for (const part of chunks([...new Set(events.map((e) => e.externalMessageId))])) {
    const rows = check(await db.from("messages").select("external_message_id, hubspot_contact_id, lead_uuid")
      .in("external_message_id", part).not("hubspot_contact_id", "is", null), "ler public.messages");
    for (const r of rows) {
      const leadId = r.lead_uuid ? leadIds.get(r.lead_uuid) : undefined;
      if (leadId) check(await p.from("leads").update({ hubspot_contact_id: r.hubspot_contact_id }).eq("id", leadId).is("hubspot_contact_id", null), "gravar hubspot_contact_id");
    }
  }

  return [...new Set(leadIds.values())];
}

export async function rebuildLeads(db: SupabaseClient, leadIds: string[]): Promise<void> {
  for (const part of chunks(leadIds, 200)) {
    check(await db.schema("painel").rpc("rebuild_leads", { p_leads: part }), "recalcular leads");
  }
}

/** Relê as notas internas já recebidas (para preencher note_tag depois da migration que criou a coluna). */
export async function reprocessNotes(db: SupabaseClient): Promise<number> {
  let n = 0;
  for (let from = 0; ; from += 500) {
    const raws = check(await db.from("raw_events").select("id, payload").eq("payload->value->>type", "NOTE").order("id").range(from, from + 499), "ler notas");
    const events = raws.map((r: { id: number; payload: unknown }) => ({ e: parsePoliEvent(r.payload), id: r.id }))
      .filter((x: { e: PoliEvent | null }) => x.e).map((x: { e: PoliEvent | null; id: number }) => ({ ...x.e!, rawEventId: x.id }));
    await upsertEvents(db, events);
    n += raws.length;
    if (raws.length < 500) return n;
  }
}

/** Recalcula todos os leads (usar depois de uma migration que muda o cálculo). */
export async function rebuildAll(db: SupabaseClient): Promise<number> {
  await reprocessNotes(db);
  const ids: string[] = [];
  for (let from = 0; ; from += 1000) {
    const rows = check(await db.schema("painel").from("leads").select("id").order("id").range(from, from + 999), "listar leads");
    ids.push(...rows.map((r: { id: string }) => r.id));
    if (rows.length < 1000) break;
  }
  await rebuildLeads(db, ids);
  return ids.length;
}

/** Processa um lote a partir do cursor. Devolve quantos eventos crus foram lidos. */
export async function processBatch(db: SupabaseClient): Promise<{ read: number; ignored: number; leads: number; cursor: number }> {
  const cursor = await getCursor(db);
  const raws = check(await db.from("raw_events").select("id, payload").gt("id", cursor).order("id").limit(config.batchSize), "ler raw_events");
  if (!raws.length) return { read: 0, ignored: 0, leads: 0, cursor };

  const events: (PoliEvent & { rawEventId: number })[] = [];
  for (const r of raws) {
    const e = parsePoliEvent(r.payload);
    if (e) events.push({ ...e, rawEventId: r.id });
  }
  const leads = await upsertEvents(db, events);
  await rebuildLeads(db, leads);
  const last = raws[raws.length - 1].id as number;
  await setCursor(db, last);
  return { read: raws.length, ignored: raws.length - events.length, leads: leads.length, cursor: last };
}
