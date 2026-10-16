"use client";

// Escolha de template com busca (pedido do Felipe, 2026-10-16: com ~3.800 templates, a lista pura não serve).
// Busca no nome e no texto, sem diferença de acento e maiúscula; os usados nos últimos 30 dias vêm primeiro.
// Preparado para filtros futuros: `filtro` recebe qualquer condição extra sobre o template.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { TemplateOpcao } from "./RegrasView";
import s from "./jornada.module.css";

const MAX = 50;
const sem = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export function TemplateBusca({ id, rotulo, lista, valor, onEscolher, filtro }: {
  id: string;
  rotulo: string;
  lista: TemplateOpcao[];
  valor: string;
  onEscolher: (uuid: string) => void;
  filtro?: (t: TemplateOpcao) => boolean;
}) {
  const atual = lista.find((t) => t.uuid === valor) ?? null;
  const [texto, setTexto] = useState("");
  const [aberto, setAberto] = useState(false);
  const [ativo, setAtivo] = useState(0);
  const caixa = useRef<HTMLDivElement>(null);
  const listaId = useId();

  const achados = useMemo(() => {
    const q = sem(texto.trim());
    const base = filtro ? lista.filter(filtro) : lista;
    const ok = q ? base.filter((t) => sem(t.key).includes(q) || sem(t.body ?? t.trecho).includes(q)) : base;
    return ok.slice(0, MAX);
  }, [texto, lista, filtro]);

  useEffect(() => {
    const fora = (e: MouseEvent) => { if (caixa.current && !caixa.current.contains(e.target as Node)) setAberto(false); };
    document.addEventListener("mousedown", fora);
    return () => document.removeEventListener("mousedown", fora);
  }, []);

  const escolher = (t: TemplateOpcao) => {
    onEscolher(t.uuid);
    setTexto("");
    setAberto(false);
  };

  return (
    <div className={s.field} ref={caixa} style={{ position: "relative" }}>
      <label htmlFor={id} className={s.lbl}>{rotulo}</label>
      <input
        id={id}
        role="combobox"
        aria-expanded={aberto}
        aria-controls={listaId}
        aria-autocomplete="list"
        autoComplete="off"
        className={s.select}
        placeholder={atual ? atual.key : "Buscar pelo nome ou pelo texto do template"}
        value={aberto ? texto : atual?.key ?? ""}
        onFocus={() => { setAberto(true); setAtivo(0); }}
        onChange={(e) => { setTexto(e.target.value); setAberto(true); setAtivo(0); }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setAtivo((i) => Math.min(i + 1, achados.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setAtivo((i) => Math.max(i - 1, 0)); }
          else if (e.key === "Enter" && aberto && achados[ativo]) { e.preventDefault(); escolher(achados[ativo]); }
          else if (e.key === "Escape") setAberto(false);
        }}
      />
      {aberto && (
        <ul id={listaId} role="listbox" className={s.busca}>
          {achados.map((t, i) => (
            <li key={t.uuid} role="option" aria-selected={t.uuid === valor}
              className={`${s.buscaItem} ${i === ativo ? s.buscaAtivo : ""}`}
              onMouseEnter={() => setAtivo(i)} onMouseDown={(e) => { e.preventDefault(); escolher(t); }}>
              <span className={s.buscaNome}>{t.key}{t.recente && <span className={s.buscaTag}>usado no mês</span>}</span>
              {(t.body ?? t.trecho) && <span className={s.buscaTexto}>{(t.body ?? t.trecho).slice(0, 110)}</span>}
            </li>
          ))}
          {!achados.length && <li className={s.buscaVazio}>Nenhum template com &quot;{texto}&quot;.</li>}
          {achados.length === MAX && <li className={s.buscaVazio}>Mostrando os primeiros {MAX}. Digite mais para afinar a busca.</li>}
        </ul>
      )}
    </div>
  );
}
