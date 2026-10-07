// Google Agenda no servidor do painel: credenciais, agenda de um closer e registro de falhas.
import { GoogleCalendar, GoogleError, accessToken, decryptToken, type GoogleCreds } from "@painel/shared/google";
import { createAdminClient } from "@/lib/supabase/admin";

export const APP_URL = `https://${process.env.APP_DOMAIN || "painel-sdr.camposai.com.br"}`;

export function googleCreds(): GoogleCreds {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Google não configurado no servidor (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).");
  return { clientId, clientSecret, redirectUri: `${APP_URL}/api/google/callback` };
}

export function tokenKey(): string {
  const k = process.env.GOOGLE_TOKEN_KEY;
  if (!k) throw new Error("GOOGLE_TOKEN_KEY não definida no servidor.");
  return k;
}

/** Registra uma chamada à agenda (falhas sempre). Sem dado de lead. */
export async function logCalendar(entry: { closer_id: string | null; meeting_id?: string | null; op: string; ok: boolean; http_status?: number | null; reason?: string | null }) {
  await createAdminClient().schema("painel").from("calendar_log").insert({ meeting_id: null, http_status: null, reason: null, ...entry });
}

/** Agenda de um closer conectado. Autorização revogada marca a conexão como desconectada. */
export async function calendarOf(closerId: string): Promise<GoogleCalendar> {
  const db = createAdminClient().schema("painel");
  const { data, error } = await db.from("google_connections").select("refresh_token_enc, status").eq("closer_id", closerId).maybeSingle();
  if (error) throw new Error(`Não foi possível ler a conexão: ${error.message}`);
  if (!data) throw new Error("Este closer ainda não conectou a agenda.");
  try {
    const token = await accessToken(googleCreds(), decryptToken(data.refresh_token_enc, tokenKey()));
    await db.from("google_connections").update({ status: "conectada", last_ok_at: new Date().toISOString(), last_error: null }).eq("closer_id", closerId);
    return new GoogleCalendar(token);
  } catch (e) {
    if (e instanceof GoogleError) {
      await logCalendar({ closer_id: closerId, op: e.op, ok: false, http_status: e.status, reason: e.reason });
      if (e.revoked) {
        await db.from("google_connections").update({ status: "desconectada", last_error: e.reason, updated_at: new Date().toISOString() }).eq("closer_id", closerId);
        throw new Error("A agenda deste closer foi desconectada. Ele precisa conectar de novo.");
      }
    }
    throw e;
  }
}

/** Executa uma operação na agenda, registrando o resultado (ok ou falha) no calendar_log. */
export async function withLog<T>(closerId: string, op: string, fn: () => Promise<T>, meetingId: string | null = null): Promise<T> {
  try {
    const r = await fn();
    await logCalendar({ closer_id: closerId, meeting_id: meetingId, op, ok: true });
    return r;
  } catch (e) {
    const g = e instanceof GoogleError ? e : null;
    await logCalendar({ closer_id: closerId, meeting_id: meetingId, op, ok: false, http_status: g?.status ?? null, reason: g?.reason ?? String((e as Error).message).slice(0, 200) });
    throw e;
  }
}
