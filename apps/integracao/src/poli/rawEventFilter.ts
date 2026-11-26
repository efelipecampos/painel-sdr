import { createHash } from "node:crypto";
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
  | "ack"
  | "atendimento"
  | "contato"
  | "contato_atualizado"
  | "tag_descarte"
  | "tag_fora_do_descarte"
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
    current_attendance?: { uuid?: unknown; attendant?: { email?: unknown } | null } | null;
    attendant?: { email?: unknown } | null;
    tag?: { uuid?: unknown; attributes?: { name?: unknown } | null } | null;
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
  /** ACK: a decisão depende de a mensagem (`uuid` do ACK) já estar gravada. */
  needsMessageLookup?: string;
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

/**
 * Atendimento e e-mail do dono nos eventos que não são mensagem: no atendimento
 * o próprio `value` é o atendimento; no contato é o `value.current_attendance`;
 * no ACK, se vier, o `value.attendance` (formato ainda não visto).
 */
function attendanceOfNonMessage(body: RawEventBody): { uuid?: string; email?: string } {
  const v = body.value;
  if (asString(body.object) === "attendance") return { uuid: asString(v?.uuid), email: asString(v?.attendant?.email) };
  const a = v?.current_attendance ?? v?.attendance;
  return { uuid: asString(a?.uuid), email: asString(a?.attendant?.email) };
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
  /** A mensagem deste ACK já está gravada em raw_events (então é da equipe). */
  messageAlreadyCaptured?: boolean;
  /** Relógio (ms) para o id dos eventos sem uuid próprio; padrão Date.now(). */
  now?: number;
}

/**
 * ACK, atendimento e contato (decisão do Felipe, 2026-10-23): o `uuid` desses
 * eventos é o da mensagem, do atendimento ou do contato, não o do evento, e se
 * repete a cada ACK, encaminhamento ou mudança. O id vira tipo + hash do corpo
 * + janela de 10 min: a reentrega igual não duplica, e o mesmo evento repetido
 * depois (ex.: o contato encaminhado de novo à mesma SDR) entra como novo.
 */
/** Prefixo das tags da Poli que descartam o Lead no HubSpot. */
export const TAG_DESCARTE_PREFIXO = "Descarte - ";

/**
 * "Descarte - <motivo>", tolerante a variações de escrita (2026-11-26: desde 13/11 as tags chegam e nenhuma era
 * reconhecida): maiúsculas, espaços, hífen/traço/dois-pontos e acentos/normalização Unicode diferentes.
 */
export function isTagDescarte(nome: string | undefined): boolean {
  return !!nome && /^descarte\s*[-‐‑‒–—:]/i.test(nome.normalize("NFC").trim());
}

/** "tag_linked" / "tag_unlinked" pelo corpo ou, se o corpo não disser, pelo cabeçalho x-webhook-event. */
export function tagEventOf(body: RawEventBody, headerEvent?: string): "tag_linked" | "tag_unlinked" | undefined {
  const fromBody = asString(body.object) === "contact" ? asString(body.event) : undefined;
  const fromHeader = headerEvent?.split(".").pop();
  for (const e of [fromBody, fromHeader]) if (e === "tag_linked" || e === "tag_unlinked") return e;
  return undefined;
}

/**
 * Tag do evento: procura em value.tag (formato visto até 12/11), value.tags[0], value.data.tag e afins; nome em
 * `attributes.name` ou `name`. Só lê o que está dentro de chaves "tag" (nada do contato).
 */
export function tagOf(body: unknown): { uuid?: string; name?: string } {
  // formato conhecido primeiro: o contato pode trazer a lista de todas as tags dele, que não é a tag do evento
  const value = (body as { value?: { tag?: unknown; data?: { tag?: unknown } } } | null)?.value;
  for (const t of [value?.tag, value?.data?.tag]) {
    if (t && typeof t === "object" && !Array.isArray(t)) {
      const o = t as Record<string, unknown>;
      const attrs = (o.attributes && typeof o.attributes === "object" ? o.attributes : {}) as Record<string, unknown>;
      const name = asString(attrs.name) ?? asString(o.name);
      if (name) return { uuid: asString(o.uuid) ?? asString(o.id), name };
    }
  }
  const found: { uuid?: string; name?: string } = {};
  const visit = (v: unknown, inTag: boolean, depth: number): void => {
    if (depth > 6 || v == null || typeof v !== "object" || (found.uuid && found.name)) return;
    if (Array.isArray(v)) { for (const x of v) visit(x, inTag, depth + 1); return; }
    const o = v as Record<string, unknown>;
    if (inTag) {
      const attrs = (o.attributes && typeof o.attributes === "object" ? o.attributes : {}) as Record<string, unknown>;
      found.name ??= asString(attrs.name) ?? asString(o.name);
      found.uuid ??= asString(o.uuid) ?? asString(o.id);
    }
    for (const [k, x] of Object.entries(o)) if (k !== "attributes") visit(x, inTag || /^tags?$/i.test(k), depth + 1);
  };
  visit(body, false, 0);
  return found;
}

export function bodyEventId(body: RawEventBody, eventType: string | undefined, now: number): string {
  const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 32);
  return `${eventType ?? "evento"}:${hash}:${Math.floor(now / 600_000)}`;
}

export function decideRawEventCapture(body: RawEventBody, options: DecideOptions = {}): CaptureDecision {
  const base = {
    externalId: externalIdOf(body),
    eventType: eventTypeOf(body, options.headerEvent),
    attendanceUuid: attendanceUuidOf(body),
  };

  const object = asString(body.object);
  const event = asString(body.event);
  const tagEvent = tagEventOf(body, options.headerEvent);

  // ACK, atendimento e contato (decisão do Felipe, 2026-10-23): só da equipe de pré-vendas, pela mesma
  // regra das mensagens: o dono do atendimento é da equipe, ou o atendimento já tem evento gravado
  // (o que cobre o fechamento e a saída do chat da equipe). O contato "atualizado" fica de fora (volume
  // alto, nada útil) e o "encaminhado" também: ele não traz o e-mail de quem recebe, e o atendimento
  // criado por encaminhamento (INITIATED_BY_FORWARDING) já registra o mesmo momento com o dono.
  const naoMensagem = (object === "message" && event === "ack") || object === "attendance" || object === "contact" || !!tagEvent;
  if (naoMensagem) {
    const reason: CaptureReason = object === "message" ? "ack" : object === "attendance" ? "atendimento" : "contato";
    // Tag no contato (descarte por tag, decisão do Felipe, 2026-10-27): o evento não traz atendimento nem quem aplicou.
    // Entra só a tag de descarte vinculada ("Descarte - ..."; criadas pelo painel). Tirar a tag não desfaz o descarte.
    if (tagEvent) {
      const id = { ...base, externalId: bodyEventId(body, base.eventType, options.now ?? Date.now()) };
      return tagEvent === "tag_linked" && isTagDescarte(tagOf(body).name)
        ? { capture: true, reason: "tag_descarte", ...id }
        : { capture: false, reason: "tag_fora_do_descarte", ...id };
    }
    if (object === "contact" && (event === "updated" || event === "forwarded")) {
      return { capture: false, reason: "contato_atualizado", ...base };
    }
    // O ACK só traz o uuid da mensagem e o status (visto em 23/10/2026): é da equipe quando a mensagem já foi gravada.
    if (reason === "ack") {
      const messageUuid = asString(body.uuid);
      const id = { ...base, externalId: bodyEventId(body, base.eventType, options.now ?? Date.now()) };
      if (!messageUuid) return { capture: false, reason: "fora_da_equipe", ...id };
      return options.messageAlreadyCaptured
        ? { capture: true, reason, ...id }
        : { capture: false, reason: "fora_da_equipe", ...id, needsMessageLookup: messageUuid };
    }
    const { uuid, email } = attendanceOfNonMessage(body);
    const decided = { ...base, attendanceUuid: uuid, externalId: bodyEventId(body, base.eventType, options.now ?? Date.now()) };
    if (getAttendantRole(email)) return { capture: true, reason, ...decided };
    if (!uuid) return { capture: false, reason: "fora_da_equipe", ...decided };
    return options.attendanceAlreadyCaptured
      ? { capture: true, reason, ...decided }
      : { capture: false, reason: "fora_da_equipe", ...decided, needsAttendanceLookup: true };
  }

  if (object !== "message") return { capture: false, reason: "nao_e_mensagem", ...base };
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
