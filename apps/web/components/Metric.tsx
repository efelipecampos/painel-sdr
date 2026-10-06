import type { ReactNode } from "react";

/** Um número com rótulo. `count` aparece pequeno ao lado (ex.: quantos leads entraram na mediana). */
export function Metric({ label, value, count, sub, stale }: {
  label: string; value: ReactNode; count?: number | null; sub?: ReactNode; stale?: boolean;
}) {
  return (
    <div className="metric">
      <span className="k">{label}</span>
      <span className="v">{value}{count != null && <small title="leads que entraram na conta">({count} leads)</small>}</span>
      {sub != null && <span className={`s${stale ? " stale" : ""}`}>{sub}</span>}
    </div>
  );
}

export function staleLabel(parados: number, minutes: number): string {
  return parados > 0 ? `${parados} parados há +${minutes} min` : `Nenhum parado há +${minutes} min`;
}
