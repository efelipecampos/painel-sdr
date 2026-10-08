// Google Agenda (Fase 10c), só no servidor: conexão do closer (OAuth), cifra do token, livre/ocupado e eventos.
// Fala direto com a API REST do Google (sem pacote extra). Nada aqui lê o conteúdo dos eventos dos closers:
// o livre/ocupado só devolve intervalos, e os eventos lidos são os que o próprio painel criou.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** Permissões pedidas ao closer: ver livre/ocupado e criar/alterar eventos; e-mail para conferir a conta. */
export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.freebusy",
  "https://www.googleapis.com/auth/calendar.events",
];
const REQUIRED = GOOGLE_SCOPES.filter((s) => s.startsWith("https://"));

export interface GoogleCreds { clientId: string; clientSecret: string; redirectUri: string }

/** Erro de uma chamada ao Google, com o que for útil para o registro de falhas (sem dado de lead). */
export class GoogleError extends Error {
  constructor(readonly op: string, readonly status: number, readonly reason: string) {
    super(`Google (${op}): ${status} ${reason}`);
  }
  /** A autorização do closer não vale mais (revogou, trocou senha, conta suspensa). */
  get revoked(): boolean {
    return this.reason === "invalid_grant" || this.reason === "unauthorized_client";
  }
}

// ---------- cifra do token (AES-256-GCM; chave de 32 bytes em base64 no .env) ----------

function keyOf(b64: string): Buffer {
  const k = Buffer.from(b64, "base64");
  if (k.length !== 32) throw new Error("GOOGLE_TOKEN_KEY precisa ter 32 bytes em base64.");
  return k;
}

export function encryptToken(plain: string, keyB64: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", keyOf(keyB64), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `v1:${Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64")}`;
}

export function decryptToken(enc: string, keyB64: string): string {
  if (!enc.startsWith("v1:")) throw new Error("Token em formato desconhecido.");
  const raw = Buffer.from(enc.slice(3), "base64");
  const d = createDecipheriv("aes-256-gcm", keyOf(keyB64), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
}

// ---------- OAuth ----------

export function authUrl(creds: GoogleCreds, state: string, loginHint?: string): string {
  const q = new URLSearchParams({
    client_id: creds.clientId,
    redirect_uri: creds.redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",           // garante o refresh_token também numa reconexão
    include_granted_scopes: "true",
    hd: "poli.digital",
    state,
  });
  if (loginHint) q.set("login_hint", loginHint);
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

type Fetch = typeof fetch;

async function failOf(op: string, r: Response): Promise<GoogleError> {
  let reason = r.statusText || "erro";
  try {
    const j = (await r.json()) as { error?: string | { status?: string; errors?: { reason?: string }[] } };
    if (typeof j.error === "string") reason = j.error;
    else if (j.error) reason = j.error.errors?.[0]?.reason ?? j.error.status ?? reason;
  } catch {
    // corpo sem JSON
  }
  return new GoogleError(op, r.status, reason);
}

export interface Connection { refreshToken: string; email: string; scopes: string[] }

/** Troca o código da volta do Google pela autorização de longo prazo. Confere permissões e conta. */
export async function exchangeCode(creds: GoogleCreds, code: string, f: Fetch = fetch): Promise<Connection> {
  const r = await f("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code, client_id: creds.clientId, client_secret: creds.clientSecret, redirect_uri: creds.redirectUri, grant_type: "authorization_code",
    }),
  });
  if (!r.ok) throw await failOf("conectar", r);
  const t = (await r.json()) as { refresh_token?: string; scope?: string; id_token?: string };
  const scopes = (t.scope ?? "").split(" ").filter(Boolean);
  const missing = REQUIRED.filter((s) => !scopes.includes(s));
  if (missing.length) throw new GoogleError("conectar", 400, "permissao_faltando");
  if (!t.refresh_token) throw new GoogleError("conectar", 400, "sem_refresh_token");
  // id_token veio direto do Google por HTTPS nesta resposta: basta ler o e-mail.
  const payload = JSON.parse(Buffer.from((t.id_token ?? "..").split(".")[1] ?? "", "base64url").toString("utf8") || "{}") as {
    email?: string; email_verified?: boolean;
  };
  if (!payload.email || payload.email_verified === false) throw new GoogleError("conectar", 400, "email_nao_verificado");
  return { refreshToken: t.refresh_token, email: payload.email.toLowerCase(), scopes };
}

/** Token de acesso curto a partir da autorização guardada. invalid_grant = closer precisa reconectar. */
export async function accessToken(creds: GoogleCreds, refreshToken: string, f: Fetch = fetch): Promise<string> {
  const r = await f("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: creds.clientId, client_secret: creds.clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
  });
  if (!r.ok) throw await failOf("autorizar", r);
  return ((await r.json()) as { access_token: string }).access_token;
}

// ---------- Agenda ----------

export interface Interval { start: Date; end: Date }

export interface CalendarEvent {
  id: string;
  status?: string;            // confirmed | tentative | cancelled
  htmlLink?: string;
  hangoutLink?: string;
  summary?: string;
  start?: { dateTime?: string };
  end?: { dateTime?: string };
  organizer?: { email?: string; self?: boolean };
  attendees?: { email: string; responseStatus?: string; self?: boolean; organizer?: boolean }[];
  conferenceData?: unknown;
}

export interface NewEvent {
  title: string;
  description: string;
  start: Date;
  end: Date;
  attendees: string[];
  colorId?: string;
  /** conferenceData de outro evento: reaproveita o mesmo link do Meet (troca de closer no reagendamento). */
  conference?: unknown;
}

const API = "https://www.googleapis.com/calendar/v3";
const enc = encodeURIComponent;

export class GoogleCalendar {
  constructor(private readonly token: string, private readonly f: Fetch = fetch) {}

  private async call<T>(op: string, url: string, init: RequestInit = {}): Promise<T> {
    const r = await this.f(url, { ...init, headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json", ...init.headers } });
    if (!r.ok) throw await failOf(op, r);
    return (r.status === 204 ? undefined : await r.json()) as T;
  }

  /** Intervalos ocupados da agenda principal do closer (sem conteúdo dos eventos). */
  async busy(from: Date, to: Date, calendarId = "primary"): Promise<Interval[]> {
    const j = await this.call<{ calendars: Record<string, { busy?: { start: string; end: string }[]; errors?: { reason: string }[] }> }>(
      "livre_ocupado", `${API}/freeBusy`,
      { method: "POST", body: JSON.stringify({ timeMin: from.toISOString(), timeMax: to.toISOString(), items: [{ id: calendarId }] }) },
    );
    const cal = Object.values(j.calendars)[0];
    if (!cal || cal.errors?.length) throw new GoogleError("livre_ocupado", 200, cal?.errors?.[0]?.reason ?? "sem_agenda");
    return (cal.busy ?? []).map((b) => ({ start: new Date(b.start), end: new Date(b.end) }));
  }

  /** Cria o evento com Meet. sendUpdates=all: convidados recebem o convite por e-mail. */
  insert(ev: NewEvent, calendarId = "primary"): Promise<CalendarEvent> {
    return this.call("criar", `${API}/calendars/${enc(calendarId)}/events?conferenceDataVersion=1&sendUpdates=all`, {
      method: "POST",
      body: JSON.stringify({
        summary: ev.title,
        description: ev.description,
        start: { dateTime: ev.start.toISOString(), timeZone: "America/Sao_Paulo" },
        end: { dateTime: ev.end.toISOString(), timeZone: "America/Sao_Paulo" },
        attendees: ev.attendees.map((email) => ({ email })),
        conferenceData: ev.conference ?? { createRequest: { requestId: randomBytes(12).toString("hex"), conferenceSolutionKey: { type: "hangoutsMeet" } } },
        reminders: { useDefault: true },
        ...(ev.colorId ? { colorId: ev.colorId } : {}),
      }),
    });
  }

  /** Muda horário, título ou cor do mesmo evento (o link do Meet continua o mesmo). */
  patch(eventId: string, p: { start?: Date; end?: Date; title?: string; colorId?: string | null; status?: "confirmed" }, calendarId = "primary", notify = true): Promise<CalendarEvent> {
    return this.call("alterar", `${API}/calendars/${enc(calendarId)}/events/${enc(eventId)}?sendUpdates=${notify ? "all" : "none"}`, {
      method: "PATCH",
      body: JSON.stringify({
        ...(p.start ? { start: { dateTime: p.start.toISOString(), timeZone: "America/Sao_Paulo" } } : {}),
        ...(p.end ? { end: { dateTime: p.end.toISOString(), timeZone: "America/Sao_Paulo" } } : {}),
        ...(p.title ? { summary: p.title } : {}),
        ...(p.colorId !== undefined ? { colorId: p.colorId } : {}), // null volta à cor padrão
        ...(p.status ? { status: p.status } : {}),                  // "confirmed" desfaz um evento apagado
      }),
    });
  }

  /** Move o evento para outra agenda (arquivo e volta). Mantém id e link do Meet. */
  move(eventId: string, destination: string, calendarId = "primary"): Promise<CalendarEvent> {
    return this.call("mover", `${API}/calendars/${enc(calendarId)}/events/${enc(eventId)}/move?destination=${enc(destination)}&sendUpdates=none`, { method: "POST" });
  }

  /** Lê um evento criado pelo painel. Apagado no Google (404/410 ou status cancelled) = null. */
  async get(eventId: string, calendarId = "primary"): Promise<CalendarEvent | null> {
    try {
      const ev = await this.call<CalendarEvent>("ler", `${API}/calendars/${enc(calendarId)}/events/${enc(eventId)}`);
      return ev.status === "cancelled" ? null : ev;
    } catch (e) {
      if (e instanceof GoogleError && (e.status === 404 || e.status === 410)) return null;
      throw e;
    }
  }

  /** Apaga (só a tela de teste usa; reunião de verdade vai para o arquivo). Já apagado conta como feito. */
  async remove(eventId: string, calendarId = "primary"): Promise<void> {
    try {
      await this.call("apagar", `${API}/calendars/${enc(calendarId)}/events/${enc(eventId)}?sendUpdates=none`, { method: "DELETE" });
    } catch (e) {
      if (e instanceof GoogleError && (e.status === 404 || e.status === 410)) return;
      throw e;
    }
  }
}

/** Cores do Google Agenda usadas no arquivo: a situação da reunião (o lead não vê a cor). */
export const ARCHIVE_COLOR = { cancelada: "11", noshow: "5" } as const; // 11 = vermelho, 5 = amarelo

/** Título no arquivo: o da reunião com o closer no final ("Apresentação Poli - Empresa X (Calil)"). */
export function archiveTitle(title: string, closer: string): string {
  const base = activeTitle(title);
  return closer ? `${base} (${closer})` : base;
}

/** Título fora do arquivo: sem o closer no final. */
export function activeTitle(title: string): string {
  return title.replace(/ \([^()]*\)$/, "");
}

// ---------- regras puras (testadas) ----------

/**
 * O closer está livre em [start, end) com o intervalo mínimo entre reuniões?
 * Um ocupado que termina exatamente gap minutos antes do início (ou começa gap minutos depois do fim) não conflita.
 */
export function isFree(busy: Interval[], start: Date, end: Date, gapMinutes: number): boolean {
  const g = gapMinutes * 60_000;
  return !busy.some((b) => b.start.getTime() < end.getTime() + g && b.end.getTime() > start.getTime() - g);
}

export type EventState = "ok" | "removida" | "recusada_lead" | "recusada_closer";

/** Situação de um evento do painel no Google (conferência periódica). */
export function eventState(ev: CalendarEvent | null, leadEmail: string | null): EventState {
  if (!ev || ev.status === "cancelled") return "removida";
  const att = ev.attendees ?? [];
  if (att.some((a) => (a.self || a.organizer) && a.responseStatus === "declined")) return "recusada_closer";
  // Lead = o e-mail informado; sem ele, qualquer convidado de fora da Poli.
  const isLead = (e: string) => (leadEmail ? e.toLowerCase() === leadEmail.toLowerCase() : !e.toLowerCase().endsWith("@poli.digital"));
  if (att.some((a) => isLead(a.email) && a.responseStatus === "declined")) return "recusada_lead";
  return "ok";
}
