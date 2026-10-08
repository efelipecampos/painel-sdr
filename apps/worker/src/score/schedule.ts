// Horários do score (decisão do Felipe, 08/10/2026): de 2 em 2 horas, das 08:00 às 18:00, todo dia (fuso de São Paulo).
import { BUSINESS_TIMEZONE } from "@painel/shared";

export const DEFAULT_SCORE_TIMES = ["08:00", "10:00", "12:00", "14:00", "16:00", "18:00"];

/** Lê "08:00,10:00,..." (SCORE_HORARIOS). Horário inválido derruba o worker na subida, para não passar despercebido. */
export function parseTimes(raw: string | undefined): string[] {
  if (!raw?.trim()) return DEFAULT_SCORE_TIMES;
  const times = raw.split(",").map((t) => t.trim()).filter(Boolean);
  for (const t of times) if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw new Error(`SCORE_HORARIOS inválido: "${t}" (use HH:MM separados por vírgula)`);
  return [...new Set(times)].sort();
}

/**
 * O horário mais recente que já passou hoje, como "AAAA-MM-DD HH:MM" (ou null antes do primeiro).
 * A rodada roda quando esse valor muda; se o worker ficou parado e perdeu vários horários, roda uma vez só.
 */
export function currentSlot(now: Date, times: string[]): string | null {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(now);
  const g = (t: string) => parts.find((x) => x.type === t)!.value;
  const hhmm = `${g("hour")}:${g("minute")}`;
  const last = times.filter((t) => t <= hhmm).pop();
  return last ? `${g("year")}-${g("month")}-${g("day")} ${last}` : null;
}
