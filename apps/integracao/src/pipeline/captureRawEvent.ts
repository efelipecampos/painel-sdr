import { env } from "../config/env.js";
import { decideRawEventCapture, type CaptureDecision, type RawEventBody } from "../poli/rawEventFilter.js";
import { isSupabaseConfigured } from "../supabase/client.js";
import { attendanceHasRawEvent, buildRawEventRow, insertRawEvent, messageHasRawEvent } from "../supabase/rawEvents.js";
import {
  isRawEventAttendanceKnown,
  markRawEventAttendance,
  recordRawEventFailure,
  clearRawEventJob,
} from "../queue/store.js";
import { logger } from "../logger.js";

/**
 * Grava o evento cru no Supabase quando ele é da equipe de pré-vendas (ver
 * decideRawEventCapture). Chamada sem await no webhook: não atrasa o 200 pra
 * Poli e nunca lança — falha vira item na fila SQLite, com retry.
 */

export interface CaptureDeps {
  insert: (row: ReturnType<typeof buildRawEventRow>) => Promise<void>;
  /** Consulta se o atendimento já tem evento gravado (fallback do índice local). */
  attendanceCaptured: (attendanceUuid: string) => Promise<boolean>;
  markAttendance: (attendanceUuid: string) => void;
  /** A mensagem do ACK já está gravada? */
  messageCaptured: (messageUuid: string) => Promise<boolean>;
  enqueueFailure: (externalId: string, eventType: string | undefined, payload: unknown, error: string) => void;
  clearJob: (externalId: string) => void;
}

const defaultDeps: CaptureDeps = {
  insert: insertRawEvent,
  attendanceCaptured: async (attendanceUuid) =>
    isRawEventAttendanceKnown(attendanceUuid) || (await attendanceHasRawEvent(attendanceUuid)),
  markAttendance: markRawEventAttendance,
  messageCaptured: (messageUuid) => (capturedMessages.has(messageUuid) ? Promise.resolve(true) : messageHasRawEvent(messageUuid)),
  enqueueFailure: recordRawEventFailure,
  clearJob: clearRawEventJob,
};

// Mensagens gravadas recentemente, para o ACK não consultar o banco a cada evento. Limitado e só em memória.
const capturedMessages = new Set<string>();
function rememberMessage(uuid: string): void {
  if (capturedMessages.size >= 20_000) capturedMessages.delete(capturedMessages.values().next().value as string);
  capturedMessages.add(uuid);
}

export interface CaptureResult extends CaptureDecision {
  stored?: boolean;
  queued?: boolean;
}

export async function captureRawEvent(
  body: RawEventBody,
  headerEvent?: string,
  deps: CaptureDeps = defaultDeps,
): Promise<CaptureResult> {
  let decision = decideRawEventCapture(body, { headerEvent });

  // A regra da saída do chat depende de consulta; só é feita quando as duas
  // primeiras regras não resolveram, pra não pesar no caminho comum.
  if (!decision.capture && decision.needsAttendanceLookup && decision.attendanceUuid) {
    const attendanceAlreadyCaptured = await deps.attendanceCaptured(decision.attendanceUuid);
    decision = decideRawEventCapture(body, { headerEvent, attendanceAlreadyCaptured });
  }

  if (!decision.capture && decision.needsMessageLookup) {
    const messageAlreadyCaptured = await deps.messageCaptured(decision.needsMessageLookup);
    decision = decideRawEventCapture(body, { headerEvent, messageAlreadyCaptured });
  }

  if (!decision.capture) return decision;
  if (!decision.externalId) {
    logger.warn({ reason: decision.reason }, "Evento sem uuid, não dá pra gravar em raw_events");
    return decision;
  }

  const row = buildRawEventRow(decision.externalId, decision.eventType, body);
  try {
    await deps.insert(row);
    if (decision.attendanceUuid) deps.markAttendance(decision.attendanceUuid);
    if (body.object === "message" && (body.event === "sent" || body.event === "received")) rememberMessage(decision.externalId);
    deps.clearJob(decision.externalId);
    return { ...decision, stored: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.enqueueFailure(decision.externalId, decision.eventType, body, message);
    logger.warn({ err, externalId: decision.externalId }, "Falha ao gravar evento cru no Supabase, enfileirado");
    return { ...decision, stored: false, queued: true };
  }
}

/** Ponto chamado pelo webhook: nunca lança, nunca bloqueia a resposta. */
export function captureRawEventSafely(body: RawEventBody, headerEvent?: string): void {
  if (!isSupabaseConfigured() || !env.RAW_EVENTS_ENABLED) return;
  void captureRawEvent(body, headerEvent).catch((err) =>
    logger.error({ err }, "Erro inesperado na captura do evento cru"),
  );
}
