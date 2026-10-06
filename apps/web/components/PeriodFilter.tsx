"use client";

// Filtro de período (Hoje, Ontem, Últimos 7 dias ou datas livres). Guarda a escolha na URL.
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

const OPTIONS = [
  { key: "hoje", label: "Hoje" },
  { key: "ontem", label: "Ontem" },
  { key: "7d", label: "Últimos 7 dias" },
];

export function PeriodFilter({ current, fromLocal, toLocal }: { current: string; fromLocal: string; toLocal: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [de, setDe] = useState(fromLocal);
  const [ate, setAte] = useState(toLocal);

  const go = (next: Record<string, string | null>) => {
    const q = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) (v === null ? q.delete(k) : q.set(k, v));
    q.delete("pagina");
    router.push(`${pathname}?${q.toString()}`);
  };

  return (
    <div className="toolbar">
      <div className="group" role="group" aria-label="Período">
        {OPTIONS.map((o) => (
          <button key={o.key} type="button" className="btn" aria-pressed={current === o.key}
            onClick={() => go({ periodo: o.key, de: null, ate: null })}>{o.label}</button>
        ))}
      </div>
      <form className="group" onSubmit={(e) => { e.preventDefault(); go({ periodo: "custom", de, ate }); }}>
        <label className="lbl" htmlFor="de">De</label>
        <input id="de" type="datetime-local" className="field" value={de} onChange={(e) => setDe(e.target.value)} />
        <label className="lbl" htmlFor="ate">Até</label>
        <input id="ate" type="datetime-local" className="field" value={ate} onChange={(e) => setAte(e.target.value)} />
        <button type="submit" className="btn" aria-pressed={current === "custom"}>Aplicar</button>
      </form>
    </div>
  );
}
