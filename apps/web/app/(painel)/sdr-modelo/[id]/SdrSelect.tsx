"use client";

import { useRouter } from "next/navigation";
import s from "../modelo.module.css";

export function SdrSelect({ id, opcoes, qs }: { id: string; opcoes: { id: string; name: string }[]; qs: string }) {
  const router = useRouter();
  return (
    <div className={s.fieldCol}>
      <label htmlFor="f-sdr" className={s.lbl}>SDR</label>
      <select id="f-sdr" className={s.input} value={id} onChange={(e) => router.push(`/sdr-modelo/${e.target.value}${qs}`)}>
        {opcoes.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
      </select>
    </div>
  );
}
