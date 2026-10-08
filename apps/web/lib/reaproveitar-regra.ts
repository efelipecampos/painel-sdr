// Regra pura de "uma reunião por lead" (decisão de 2026-10-07). Ver lib/reaproveitar.ts.
import { localDay, localToDate } from "./time";

export type Janela = "mes" | "30d";

/** Início do prazo: 1º dia do mês corrente (fuso de negócio) ou 30 dias atrás. */
export function inicioDoPrazo(janela: Janela, now = new Date()): Date {
  return janela === "30d" ? new Date(now.getTime() - 30 * 86400_000) : localToDate(`${localDay(now).slice(0, 8)}01`);
}

export interface Reaproveitavel { id: string; status: string; starts_at: string; sdr_id: string | null; created_by: string | null; closer: string | null; sdr: string | null }

/** Regra pura (testada): qual reunião anterior deve ser reaproveitada, se alguma. */
export function escolherReaproveitavel<T extends { status: string; starts_at: string }>(ms: T[], inicio: Date, now = new Date()): T | null {
  const ok = ms.filter((m) =>
    (m.status === "agendada" && (Date.parse(m.starts_at) > now.getTime() || Date.parse(m.starts_at) >= inicio.getTime()))
    || ((m.status === "cancelada" || m.status === "noshow") && Date.parse(m.starts_at) >= inicio.getTime()));
  return ok.sort((a, b) => Date.parse(b.starts_at) - Date.parse(a.starts_at))[0] ?? null;
}

