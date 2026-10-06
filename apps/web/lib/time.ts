// Datas e durações na borda da tela. O banco guarda tudo em UTC; aqui convertemos de/para o fuso de negócio.
import { BUSINESS_TIMEZONE } from "@painel/shared";

const TZ = BUSINESS_TIMEZONE;

/** Diferença (ms) entre o horário local do fuso e UTC num instante. Ex.: São Paulo = -3 h. */
function tzOffsetMs(at: Date, tz = TZ): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** "2026-10-05T09:30" no fuso de negócio → Date (instante UTC). */
export function localToDate(local: string, tz = TZ): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(local);
  if (!m) throw new Error(`Data inválida: ${local}`);
  const naive = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0));
  // Duas passadas para acertar o deslocamento perto de mudanças de horário de verão.
  let utc = naive - tzOffsetMs(new Date(naive), tz);
  utc = naive - tzOffsetMs(new Date(utc), tz);
  return new Date(utc);
}

/** Date → "2026-10-05T09:30" no fuso de negócio (formato do input datetime-local). */
export function dateToLocal(at: Date, tz = TZ): string {
  const p = new Date(at.getTime() + tzOffsetMs(at, tz));
  return p.toISOString().slice(0, 16);
}

/** Dia local (YYYY-MM-DD) de um instante. */
export function localDay(at: Date, tz = TZ): string {
  return dateToLocal(at, tz).slice(0, 10);
}

/** Soma dias a um dia local YYYY-MM-DD. */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export type PeriodKey = "hoje" | "ontem" | "7d" | "custom";

export interface Period {
  key: PeriodKey;
  from: Date;      // início, inclusive
  to: Date;        // fim, exclusivo (o banco usa [de, até))
  fromLocal: string;
  toLocal: string; // fim exibido ao usuário (inclusive, ao minuto)
  label: string;
}

const fmtDayMonth = (local: string) => `${local.slice(8, 10)}/${local.slice(5, 7)}`;

/**
 * Período a partir dos parâmetros da URL (?periodo=hoje|ontem|7d|custom&de=...&ate=...).
 * "Hoje" = 00:00 de hoje até 00:00 de amanhã, no fuso de negócio. Custom usa os minutos informados,
 * com o fim inclusivo (até 23:59 inclui o minuto 23:59).
 */
export function resolvePeriod(params: { periodo?: string; de?: string; ate?: string }, now = new Date()): Period {
  const today = localDay(now);
  const day = (from: string, toExclusive: string, key: PeriodKey, label: string): Period => {
    const to = localToDate(toExclusive);
    return { key, from: localToDate(from), to, fromLocal: `${from}T00:00`, toLocal: dateToLocal(new Date(to.getTime() - 60_000)), label };
  };
  if (params.periodo === "custom" && params.de && params.ate) {
    try {
      const from = localToDate(params.de);
      const to = new Date(localToDate(params.ate).getTime() + 60_000);
      if (to > from) {
        return { key: "custom", from, to, fromLocal: params.de, toLocal: params.ate,
          label: `${fmtDayMonth(params.de)} ${params.de.slice(11, 16)} até ${fmtDayMonth(params.ate)} ${params.ate.slice(11, 16)}` };
      }
    } catch {
      // datas inválidas: cai no padrão
    }
  }
  if (params.periodo === "ontem") return day(addDays(today, -1), today, "ontem", `Ontem (${fmtDayMonth(addDays(today, -1))})`);
  if (params.periodo === "7d") return day(addDays(today, -6), addDays(today, 1), "7d", `Últimos 7 dias (${fmtDayMonth(addDays(today, -6))} a ${fmtDayMonth(today)})`);
  return day(today, addDays(today, 1), "hoje", `Hoje (${fmtDayMonth(today)})`);
}

/** Duração em segundos → "20s", "2min58", "1h05", "2d 3h". Null → "—". */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null) return "—";
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}min${String(s % 60).padStart(2, "0")}`;
  if (s < 86400) return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

/** Instante → "05/10 14:32" no fuso de negócio. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const l = dateToLocal(new Date(iso));
  return `${fmtDayMonth(l)} ${l.slice(11, 16)}`;
}

/** Instante → "14:32" no fuso de negócio. */
export function formatTime(at: Date): string {
  return dateToLocal(at).slice(11, 16);
}
