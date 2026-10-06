"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

export function SortSelect({ value }: { value: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  return (
    <div className="group">
      <label className="lbl" htmlFor="ordem">Ordenar por</label>
      <select id="ordem" className="field" value={value} onChange={(e) => {
        const q = new URLSearchParams(params.toString());
        q.set("ordem", e.target.value);
        router.push(`${pathname}?${q.toString()}`);
      }}>
        <option value="aguardando">Mais leads aguardando</option>
        <option value="primeira">1ª resposta mais lenta</option>
        <option value="resposta">Resposta mais lenta</option>
        <option value="abordados">Mais leads abordados</option>
        <option value="agendados">Mais agendados</option>
        <option value="descartados">Mais descartados</option>
      </select>
    </div>
  );
}
