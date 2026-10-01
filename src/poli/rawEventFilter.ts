import { env } from "../config/env.js";
import { getAttendantRole } from "../config/team.js";

/**
 * Filtro do que vai pro `raw_events` no Supabase (base do painel de SDR).
 *
 * O painel precisa do evento cru — inclusive SYSTEM (transferência,
 * encerramento) e os campos que o fluxo do HubSpot descarta — mas só da
 * equipe de pré-vendas. Decisão do Felipe em 2026-09-30, ver
 * docs/integracao-mudancas.md no repositório do painel.
 *
 * Esta função é pura: quem chama resolve o `attendanceAlreadyCaptured`.
 */

export type CaptureReason =
  | "dono_da_equipe"
  | "app_token"
  | "saida_do_chat_da_equipe"
  | "nao_e_mensagem"
  | "ack_ou_atualizacao"
  | "fora_da_equipe";

export interface RawEventBody {
  object?: unknown;
  event?: unknown;
  uuid?: unknown;
  value?: {
    uuid?: unknown;
    type?: unknown;
    direction?: unknown;
    template?: unknown;
    author?: { type?: unknown; uuid?: unknown } | null;
    attendance?: { uuid?: unknown; attendant?: { email?: unknown } | null } | null;
  } | null;
}

export interface CaptureDecision {
  capture: boolean;
  reason: CaptureReason;
  externalId?: string;
  eventType?: string;
  attendanceUuid?: string;
  /** true quando a decisão depende de o atendimento já ter evento gravado. */
  needsAttendanceLookup?: boolean;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function externalIdOf(body: RawEventBody): string | undefined {
  return asString(body.uuid) ?? asString(body.value?.uuid);
}

export function eventTypeOf(body: RawEventBody, headerEvent?: string): string | undefined {
  if (headerEvent) return headerEvent;
  const fromBody = [asString(body.object), asString(body.event)].filter(Boolean).join(".");
  return fromBody === "" ? undefined : fromBody;
}

export function attendanceUuidOf(body: RawEventBody): string | undefined {
  return asString(body.value?.attendance?.uuid);
}

/** SYSTEM = transferência, encerramento e afins; não é conversa com o lead. */
export function isSystemEvent(body: RawEventBody): boolean {
  const direction = asString(body.value?.direction);
  const type = asString(body.value?.type) ?? "";
  return direction === "SYSTEM" || type.startsWith("ATTENDANCE_");
}

/**
 * Mensagem enviada pelo bot do app token: nos eventos reais ela vem com
 * `author: { type: "USER" }` — sem uuid e sem attributes — e com template
 * preenchido. Não existe no payload nenhum campo que nomeie o app/token, por
 * isso a regra é essa e fica atrás de env pra poder ser desligada.
 */
export function isAppTokenMessage(body: RawEventBody): boolean {
  if (!env.POLI_APP_TOKEN_AUTHORLESS_TEMPLATES) return false;
  if (asString(body.event) !== "sent") return false;
  if (body.value?.template == null) return false;
  return asString(body.value?.author?.uuid) === undefined;
}

export interface DecideOptions {
  headerEvent?: string;
  /** O atendimento deste evento já tem evento gravado em raw_events. */
  attendanceAlreadyCaptured?: boolean;
}

export function decideRawEventCapture(body: RawEventBody, options: DecideOptions = {}): CaptureDecision {
  const base = {
    externalId: externalIdOf(body),
    eventType: eventTypeOf(body, options.headerEvent),
    attendanceUuid: attendanceUuidOf(body),
  };

  if (asString(body.object) !== "message") return { capture: false, reason: "nao_e_mensagem", ...base };

  const event = asString(body.event);
  if (event !== "received" && event !== "sent") return { capture: false, reason: "ack_ou_atualizacao", ...base };

  // 1) Dono do chat é da equipe: a conversa inteira entra, qualquer autor.
  if (getAttendantRole(asString(body.value?.attendance?.attendant?.email))) {
    return { capture: true, reason: "dono_da_equipe", ...base };
  }

  // 2) Disparo do bot pelo app token, mesmo sem dono da equipe.
  if (isAppTokenMessage(body)) return { capture: true, reason: "app_token", ...base };

  // 3) Saída do chat da equipe: só evento SYSTEM de atendimento já conhecido,
  //    senão o painel acha que o SDR continua dono do chat.
  if (isSystemEvent(body) && base.attendanceUuid) {
    return options.attendanceAlreadyCaptured
      ? { capture: true, reason: "saida_do_chat_da_equipe", ...base }
      : { capture: false, reason: "fora_da_equipe", ...base, needsAttendanceLookup: true };
  }

  return { capture: false, reason: "fora_da_equipe", ...base };
}
