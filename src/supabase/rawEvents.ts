import { supabaseFetch } from "./client.js";

/**
 * Evento cru da Poli em `public.raw_events` — o painel de SDR reconstrói
 * chats, donos, status e tempos de resposta a partir daqui. A tabela é criada
 * pelas migrations do repositório do painel; aqui só escrevemos.
 */

export const RAW_EVENT_SOURCE = "poli_webhook";

export interface RawEventRow {
  source: string;
  event_type: string | null;
  external_id: string;
  payload: unknown;
}

export function buildRawEventRow(externalId: string, eventType: string | undefined, payload: unknown): RawEventRow {
  return { source: RAW_EVENT_SOURCE, event_type: eventType ?? null, external_id: externalId, payload };
}

/**
 * Insere ignorando duplicata: a chave única (source, external_id) faz a
 * reentrega do mesmo evento pela Poli não virar linha nova.
 */
export async function insertRawEvent(row: RawEventRow): Promise<void> {
  await supabaseFetch("/raw_events?on_conflict=source,external_id", {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
    body: JSON.stringify([row]),
  });
}

/** Já existe evento gravado para este atendimento? (regra da saída do chat) */
export async function attendanceHasRawEvent(attendanceUuid: string): Promise<boolean> {
  const query = [
    "select=id",
    `source=eq.${encodeURIComponent(RAW_EVENT_SOURCE)}`,
    `payload->value->attendance->>uuid=eq.${encodeURIComponent(attendanceUuid)}`,
    "limit=1",
  ].join("&");
  const rows = await supabaseFetch<Array<{ id: number }>>(`/raw_events?${query}`);
  return rows.length > 0;
}
