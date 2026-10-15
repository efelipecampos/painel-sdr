// Cabeçalho da Jornada: título e as seções (Regras, Acompanhamento, Prioridade da lista em breve), como no desenho.
import Link from "next/link";
import s from "./jornada.module.css";

export function JornadaTabs({ atual }: { atual: "regras" | "acompanhamento" }) {
  return (
    <div className={s.head}>
      <h1 className={s.h1}>Jornada</h1>
      <nav aria-label="Seções da jornada" className={s.tabs}>
        <Link href="/jornada" aria-current={atual === "regras" ? "page" : undefined} className={`${s.tab} ${atual === "regras" ? s.tabOn : ""}`}>Regras</Link>
        <Link href="/jornada/acompanhamento" aria-current={atual === "acompanhamento" ? "page" : undefined} className={`${s.tab} ${atual === "acompanhamento" ? s.tabOn : ""}`}>Acompanhamento</Link>
        <span aria-disabled="true" className={s.tabSoon}>Prioridade da lista <small>em breve</small></span>
      </nav>
    </div>
  );
}
