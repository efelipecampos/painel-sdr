"use client";

import { useRouter, useSearchParams } from "next/navigation";

// Anterior · dia · Próximo · Hoje (design/Reunioes.dc.html). Mantém os outros filtros da URL.
export function DayNav({ day, today, prev, next }: { day: string; today: string; prev: string; next: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const go = (d: string) => {
    const p = new URLSearchParams(params.toString());
    if (d === today) p.delete("dia"); else p.set("dia", d);
    router.push(`/reunioes${p.size ? `?${p}` : ""}`);
  };
  return (
    <div className="group">
      <button type="button" className="btn" onClick={() => go(prev)}>Anterior</button>
      <label htmlFor="day" className="sr-only">Dia</label>
      <input id="day" type="date" className="field" value={day} onChange={(e) => e.target.value && go(e.target.value)} />
      <button type="button" className="btn" onClick={() => go(next)}>Próximo</button>
      <button type="button" className="btn" style={{ background: "var(--surface-input)" }} onClick={() => go(today)}>Hoje</button>
    </div>
  );
}
