// Agendamento no servidor (Fase 10d): regras, disponibilidade real (Google + painel) e contagem às cegas.
// Nada daqui devolve ao navegador id ou nome de closer antes da confirmação: só contagens.
import { GoogleError, isFreeOcupado, type Ocupado } from "@painel/shared/google";
import { calendarOf, logCalendar } from "@/lib/google";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AgendaRules } from "@/lib/slots";
import { addDays, localToDate } from "@/lib/time";

export interface CarouselRules {
  id: string; brand: "poli" | "chatshub"; name: string; active: boolean; gap_minutes: number; min_notice_minutes: number;
  window_business_days: number; durations: number[]; sticky_days: number;
}

const admin = () => createAdminClient().schema("painel");

export async function loadRules(carouselId: string): Promise<{ carousel: CarouselRules; rules: AgendaRules; inviteSdr: boolean }> {
  const db = admin();
  const [car, hours, hol, settings] = await Promise.all([
    db.from("carousels").select("id, brand, name, active, gap_minutes, min_notice_minutes, window_business_days, durations, sticky_days").eq("id", carouselId).maybeSingle(),
    db.from("business_hours").select("weekday, enabled, start_time, end_time"),
    db.from("holidays").select("day"),
    db.from("settings").select("key, value"),
  ]);
  if (!car.data || !car.data.active) throw new Error("Carrossel inexistente ou arquivado.");
  const v = new Map((settings.data ?? []).map((r) => [r.key as string, r.value as unknown]));
  const str = (k: string, d: string) => (typeof v.get(k) === "string" && v.get(k) ? String(v.get(k)) : d);
  return {
    carousel: car.data as CarouselRules,
    rules: {
      hours: (hours.data ?? []) as AgendaRules["hours"],
      holidays: new Set((hol.data ?? []).map((h) => String(h.day))),
      holidaysOff: v.get("holidays_off") !== false,
      lunchStart: str("lunch_start", "12:00"),
      lunchEnd: str("lunch_end", "13:30"),
      manualMin: str("manual_min_time", "07:00"),
      manualMax: str("manual_max_time", "20:00"),
      gridFirst: str("grid_first_time", "08:15"),
      minNoticeMinutes: car.data.min_notice_minutes,
      windowBusinessDays: car.data.window_business_days,
    },
    inviteSdr: v.get("google_invite_sdr") !== false,
  };
}

/** Closers que podem receber esta reunião: o closer a que o lead está preso, ou os elegíveis do carrossel. */
export async function candidates(carouselId: string, leadId: string | null, hubspotContactId: string | null): Promise<string[]> {
  const db = admin();
  const { data: preso, error: e1 } = await db.rpc("closer_preso", { p_carousel: carouselId, p_lead: leadId, p_hubspot_contact_id: hubspotContactId });
  if (e1) throw new Error(e1.message);
  if (preso) return [preso as string];
  const { data, error } = await db.rpc("closers_elegiveis", { p_carousel: carouselId });
  if (error) throw new Error(error.message);
  return (data ?? []).map((r: { closer_id: string }) => r.closer_id);
}

/**
 * Ocupado de cada closer entre from e to: Google (livre/ocupado) e reuniões do painel, separados (o intervalo do
 * carrossel só vale entre reuniões do painel). Closer cuja agenda falhou fica fora (não aparece como livre) e a falha é registrada.
 */
export async function busyOf(closers: string[], from: Date, to: Date, ignoreMeeting: string | null = null): Promise<Map<string, Ocupado>> {
  const out = new Map<string, Ocupado>();
  const { data: ms } = await admin().from("meetings").select("id, closer_id, starts_at, ends_at")
    .eq("source", "painel").neq("status", "cancelada").in("closer_id", closers.length ? closers : ["00000000-0000-0000-0000-000000000000"])
    .lt("starts_at", to.toISOString()).gt("ends_at", from.toISOString());
  await Promise.all(closers.map(async (c) => {
    try {
      const cal = await calendarOf(c);
      const g = await cal.busy(from, to);
      const p = (ms ?? []).filter((m) => m.closer_id === c && m.id !== ignoreMeeting).map((m) => ({ start: new Date(m.starts_at), end: new Date(m.ends_at) }));
      out.set(c, { google: g, painel: p });
    } catch (e) {
      if (e instanceof GoogleError) await logCalendar({ closer_id: c, op: e.op, ok: false, http_status: e.status, reason: e.reason });
      else await logCalendar({ closer_id: c, op: "livre_ocupado", ok: false, reason: String((e as Error).message).slice(0, 200) });
    }
  }));
  return out;
}

/** Closers livres num intervalo exato (intervalo mínimo do carrossel só entre reuniões do painel). */
export function freeAt(busy: Map<string, Ocupado>, start: Date, end: Date, gap: number): string[] {
  return [...busy.entries()].filter(([, b]) => isFreeOcupado(b, start, end, gap)).map(([c]) => c);
}

/** Contagem de closers livres por horário de um dia (às cegas). */
export async function countByStart(carouselId: string, leadId: string | null, hs: string | null, day: string, starts: string[], duration: number, gap: number) {
  const closers = await candidates(carouselId, leadId, hs);
  const busy = await busyOf(closers, localToDate(`${day}T00:00`), localToDate(`${addDays(day, 1)}T00:00`));
  return starts.map((hhmm) => {
    const s = localToDate(`${day}T${hhmm}`);
    return { start: hhmm, count: freeAt(busy, s, new Date(s.getTime() + duration * 60_000), gap).length };
  });
}

/** Contagem às cegas de uma semana inteira, com uma consulta ao Google por closer. */
export async function countWeek(closers: string[], days: { day: string; starts: string[] }[], duration: number, gap: number, ignoreMeeting: string | null = null) {
  const open = days.filter((d) => d.starts.length);
  if (!open.length) return new Map<string, { start: string; count: number }[]>();
  const busy = await busyOf(closers, localToDate(`${open[0].day}T00:00`), localToDate(`${addDays(open[open.length - 1].day, 1)}T00:00`), ignoreMeeting);
  return new Map(open.map((d) => [d.day, d.starts.map((hhmm) => {
    const s = localToDate(`${d.day}T${hhmm}`);
    return { start: hhmm, count: freeAt(busy, s, new Date(s.getTime() + duration * 60_000), gap).length };
  })]));
}
