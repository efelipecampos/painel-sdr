// Horários do agendamento (Fase 10d), no fuso de negócio. Regras de docs/agendamento.md, seção 4, item 3:
// a grade oferece só o expediente padrão (dias úteis, fora do almoço, até as 18:00), com antecedência mínima
// e janela de dias úteis; o ajuste manual pode sair do padrão dentro do limite absoluto, com aviso.
import { addDays, localDay, localToDate } from "./time";

export interface BusinessHour { weekday: number; enabled: boolean; start_time: string; end_time: string }

export interface AgendaRules {
  hours: BusinessHour[];
  holidays: Set<string>;     // AAAA-MM-DD
  holidaysOff: boolean;
  lunchStart: string;        // "12:00"
  lunchEnd: string;          // "13:30"
  manualMin: string;         // "07:00"
  manualMax: string;         // "20:00"
  minNoticeMinutes: number;
  windowBusinessDays: number;
}

/** A grade nunca passa das 18:00 (expediente padrão das reuniões). */
export const GRID_END = "18:00";
export const GRID_STEP_MINUTES = 30;

const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const fromMin = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const weekday = (day: string) => new Date(`${day}T12:00:00Z`).getUTCDay();

function hoursOf(day: string, r: AgendaRules): BusinessHour | null {
  const h = r.hours.find((x) => x.weekday === weekday(day));
  if (!h || !h.enabled) return null;
  if (r.holidaysOff && r.holidays.has(day)) return null;
  return h;
}

export const isBusinessDay = (day: string, r: AgendaRules) => hoursOf(day, r) !== null;

/** Os próximos N dias úteis a partir de hoje (hoje entra se for útil). */
export function windowDays(now: Date, r: AgendaRules): string[] {
  const out: string[] = [];
  for (let d = localDay(now), i = 0; out.length < r.windowBusinessDays && i < 60; d = addDays(d, 1), i++) {
    if (isBusinessDay(d, r)) out.push(d);
  }
  return out;
}

/** Inícios ("HH:mm") da grade num dia, para a duração dada. */
export function gridSlots(day: string, duration: number, r: AgendaRules, now: Date): string[] {
  const h = hoursOf(day, r);
  if (!h) return [];
  const earliest = now.getTime() + r.minNoticeMinutes * 60_000;
  const end = Math.min(toMin(h.end_time.slice(0, 5)), toMin(GRID_END));
  const [ls, le] = [toMin(r.lunchStart), toMin(r.lunchEnd)];
  const out: string[] = [];
  for (let m = Math.ceil(toMin(h.start_time.slice(0, 5)) / GRID_STEP_MINUTES) * GRID_STEP_MINUTES; m + duration <= end; m += GRID_STEP_MINUTES) {
    if (m < le && m + duration > ls) continue;  // pega o almoço
    if (localToDate(`${day}T${fromMin(m)}`).getTime() < earliest) continue;
    out.push(fromMin(m));
  }
  return out;
}

export interface ManualCheck { erro: string | null; avisos: string[]; foraDoPadrao: boolean }

/** Confere um horário escolhido à mão ("AAAA-MM-DDTHH:mm" local) e uma duração em minutos. */
export function checkManual(local: string, duration: number, r: AgendaRules, now: Date): ManualCheck {
  const fail = (erro: string): ManualCheck => ({ erro, avisos: [], foraDoPadrao: false });
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) return fail("Horário inválido.");
  if (!Number.isInteger(duration) || duration < 10 || duration > 240) return fail("A duração precisa ser de 10 a 240 minutos.");
  const day = local.slice(0, 10);
  const s = toMin(local.slice(11));
  const e = s + duration;
  if (s < toMin(r.manualMin) || e > toMin(r.manualMax)) return fail(`O horário precisa ficar entre ${r.manualMin} e ${r.manualMax}.`);
  if (localToDate(local).getTime() < now.getTime() + r.minNoticeMinutes * 60_000) {
    return fail(`A reunião precisa ser marcada com pelo menos ${r.minNoticeMinutes / 60} h de antecedência.`);
  }
  const days = windowDays(now, r);
  if (day < localDay(now) || day > days[days.length - 1]) return fail(`O dia precisa estar dentro dos próximos ${r.windowBusinessDays} dias úteis.`);
  const avisos: string[] = [];
  const h = hoursOf(day, r);
  if (!h) avisos.push("Dia fora do expediente (fim de semana ou feriado)");
  else if (s < toMin(h.start_time.slice(0, 5))) avisos.push(`Começa antes das ${h.start_time.slice(0, 5)}`);
  if (s < toMin(r.lunchEnd) && e > toMin(r.lunchStart)) avisos.push("Pega o horário de almoço");
  if (e > toMin(GRID_END)) avisos.push(`Termina depois das ${GRID_END}`);
  return { erro: null, avisos, foraDoPadrao: avisos.length > 0 };
}

/** "AAAA-MM-DDTHH:mm" local + duração → instantes. */
export function interval(local: string, duration: number): { start: Date; end: Date } {
  const start = localToDate(local);
  return { start, end: new Date(start.getTime() + duration * 60_000) };
}

