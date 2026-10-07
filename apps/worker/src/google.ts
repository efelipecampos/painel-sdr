// Conferência periódica do Google Agenda (Fase 10c): a autorização de cada closer ainda vale? Os eventos das
// reuniões agendadas ainda existem, e o lead ou o closer recusaram? Não muda a reunião sozinho: marca a
// situação (google_state) para o painel mostrar o aviso. Toda falha vai para painel.calendar_log.
import type { SupabaseClient } from "@supabase/supabase-js";
import { GoogleCalendar, GoogleError, accessToken, decryptToken, eventState } from "@painel/shared/google";
import { config } from "./config.js";

type Log = { closer_id: string; meeting_id?: string | null; op: string; ok: boolean; http_status?: number | null; reason?: string | null };

export async function checkGoogle(db: SupabaseClient): Promise<{ conectadas: number; desconectadas: number; eventos: number; avisos: number }> {
  const g = config.google!;
  const p = db.schema("painel");
  const logs: Log[] = [];
  const out = { conectadas: 0, desconectadas: 0, eventos: 0, avisos: 0 };

  const { data: conns, error } = await p.from("google_connections").select("closer_id, refresh_token_enc, status");
  if (error) throw new Error(`ler conexões do Google: ${error.message}`);
  const cals = new Map<string, GoogleCalendar>();
  for (const c of conns ?? []) {
    try {
      const token = await accessToken(g, decryptToken(c.refresh_token_enc, g.tokenKey));
      cals.set(c.closer_id, new GoogleCalendar(token));
      await p.from("google_connections").update({ status: "conectada", last_ok_at: new Date().toISOString(), last_error: null }).eq("closer_id", c.closer_id);
      out.conectadas++;
    } catch (e) {
      const ge = e instanceof GoogleError ? e : null;
      logs.push({ closer_id: c.closer_id, op: "autorizar", ok: false, http_status: ge?.status ?? null, reason: ge?.reason ?? "erro_interno" });
      if (ge?.revoked) {
        await p.from("google_connections").update({ status: "desconectada", last_error: ge.reason, updated_at: new Date().toISOString() }).eq("closer_id", c.closer_id);
        out.desconectadas++;
      }
    }
  }

  // Reuniões agendadas pelo painel, de 1 hora atrás até 30 dias à frente, com evento na agenda do closer.
  const now = Date.now();
  const { data: ms, error: me } = await p.from("meetings")
    .select("id, closer_id, google_event_id, google_calendar_id, google_state")
    .eq("source", "painel").eq("status", "agendada").not("google_event_id", "is", null)
    .gte("starts_at", new Date(now - 3600_000).toISOString()).lte("starts_at", new Date(now + 30 * 86400_000).toISOString());
  if (me) throw new Error(`ler reuniões: ${me.message}`);
  for (const m of ms ?? []) {
    const cal = cals.get(m.closer_id);
    if (!cal) continue;
    try {
      const st = eventState(await cal.get(m.google_event_id, m.google_calendar_id || "primary"), null);
      out.eventos++;
      if (st !== "ok") out.avisos++;
      if (st !== m.google_state && st !== "ok") logs.push({ closer_id: m.closer_id, meeting_id: m.id, op: "ler", ok: false, reason: st });
      await p.from("meetings").update({ google_state: st, google_checked_at: new Date().toISOString() }).eq("id", m.id);
    } catch (e) {
      const ge = e instanceof GoogleError ? e : null;
      logs.push({ closer_id: m.closer_id, meeting_id: m.id, op: "ler", ok: false, http_status: ge?.status ?? null, reason: ge?.reason ?? "erro_interno" });
    }
  }
  if (logs.length) await p.from("calendar_log").insert(logs.map((l) => ({ meeting_id: null, http_status: null, reason: null, ...l })));
  return out;
}
