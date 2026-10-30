"use client";

// De/até em dias inteiros (design SDR Modelo). Guarda a escolha na URL; mudar uma data já aplica.
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import s from "./modelo.module.css";

export function DateRange({ de, ate }: { de: string; ate: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const go = (k: "de" | "ate", v: string) => {
    if (!v) return;
    const q = new URLSearchParams(params.toString());
    q.set("de", k === "de" ? v : de);
    q.set("ate", k === "ate" ? v : ate);
    router.push(`${pathname}?${q.toString()}`);
  };
  return (
    <>
      <div className={s.fieldCol}>
        <label htmlFor="de" className={s.lbl}>De</label>
        <input id="de" type="date" className={s.input} defaultValue={de} key={`de${de}`} onChange={(e) => go("de", e.target.value)} />
      </div>
      <div className={s.fieldCol}>
        <label htmlFor="ate" className={s.lbl}>Até</label>
        <input id="ate" type="date" className={s.input} defaultValue={ate} key={`ate${ate}`} onChange={(e) => go("ate", e.target.value)} />
      </div>
    </>
  );
}
