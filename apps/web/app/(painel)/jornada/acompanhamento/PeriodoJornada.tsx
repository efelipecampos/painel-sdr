"use client";

// Período do Acompanhamento, como no desenho: Hoje, 7 dias, Este mês, Mês passado, ou De/Até. Fica na URL.
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import s from "../jornada.module.css";

const OPCOES = [["hoje", "Hoje"], ["7d", "7 dias"], ["mes", "Este mês"], ["passado", "Mês passado"]] as const;

export function PeriodoJornada({ atual, de, ate }: { atual: string; de: string; ate: string }) {
  const router = useRouter();
  const path = usePathname();
  const tpl = useSearchParams().get("template");
  const ir = (q: Record<string, string>) => router.push(`${path}?${new URLSearchParams({ ...q, ...(tpl ? { template: tpl } : {}) }).toString()}`);
  return (
    <>
      <div role="group" aria-label="Período" className={s.chips}>
        {OPCOES.map(([k, rotulo]) => (
          <button key={k} type="button" aria-pressed={atual === k} onClick={() => ir({ periodo: k })} className={`${s.chip} ${atual === k ? s.chipOn : ""}`}>{rotulo}</button>
        ))}
      </div>
      <div className={s.dates}>
        <label htmlFor="from" className={s.dateLbl}>De</label>
        <input id="from" type="date" defaultValue={de} className={s.date} onChange={(e) => e.target.value && ir({ periodo: "custom", de: e.target.value, ate })} />
        <label htmlFor="to" className={s.dateLbl}>Até</label>
        <input id="to" type="date" defaultValue={ate} className={s.date} onChange={(e) => e.target.value && ir({ periodo: "custom", de, ate: e.target.value })} />
      </div>
    </>
  );
}
