"use client";

// Funil da jornada, no desenho de design/JornadaAcompanhamento.dc.html: barras de expediente e fora do expediente por
// etapa, a % que passou para a próxima e o detalhe da passagem ao passar o mouse.
import { useState } from "react";
import s from "../jornada.module.css";

export interface Etapa { nome: string; exp: number; fora: number }

const n = (x: number) => x.toLocaleString("pt-BR");
const pct = (a: number, b: number, casa = false) => (b ? `${(a / b * 100).toFixed(casa ? 1 : 0).replace(".", ",")}%` : "—");
const TRILHO = 300;

export function FunilView({ etapas }: { etapas: Etapa[] }) {
  const [hover, setHover] = useState(-1);
  const max = Math.max(1, ...etapas.map((e) => Math.max(e.exp, e.fora)));
  const largura = (v: number) => Math.max(2, Math.round((v / max) * TRILHO));
  const [criado, , , agendou] = etapas;
  const ultimo = etapas.length - 1;

  const detalhe = hover >= 0 && hover < ultimo
    ? `${etapas[hover].nome} → ${etapas[hover + 1].nome}: expediente ${n(etapas[hover].exp)} → ${n(etapas[hover + 1].exp)} (${pct(etapas[hover + 1].exp, etapas[hover].exp)}), fora do expediente ${n(etapas[hover].fora)} → ${n(etapas[hover + 1].fora)} (${pct(etapas[hover + 1].fora, etapas[hover].fora)}).`
    : hover === ultimo
      ? `Agendamento sobre os leads criados: expediente ${pct(agendou.exp, criado.exp, true)}, fora do expediente ${pct(agendou.fora, criado.fora, true)}.`
      : "Expediente e fora do expediente pela hora em que o Lead foi criado. Leads com DSQ ficam fora do funil.";

  return (
    <section aria-labelledby="sec-funil" className={s.funil}>
      <div className={s.funilHead}>
        <div>
          <h2 id="sec-funil" className={s.h2}>Funil da jornada</h2>
          <span className={s.note}>Separado pela hora em que o lead foi criado. Passe o mouse numa etapa para ver a passagem.</span>
        </div>
        <div aria-hidden="true" className={s.legendFunil}>
          <span><span className={`${s.sw} ${s.swExp}`} />Expediente</span>
          <span><span className={`${s.sw} ${s.swFora}`} />Fora do expediente</span>
        </div>
      </div>

      <div className={s.insight}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, marginTop: 1 }}><path d="M3 3v18h18" /><path d="M7 15l4-4 3 3 6-6" /></svg>
        <span>
          {criado.exp + criado.fora
            ? `Agendaram ${pct(agendou.exp + agendou.fora, criado.exp + criado.fora, true)} dos ${n(criado.exp + criado.fora)} leads criados no período: ${pct(agendou.exp, criado.exp, true)} dos que chegaram no expediente e ${pct(agendou.fora, criado.fora, true)} dos que chegaram fora.`
            : "Nenhum lead novo no período."}
        </span>
      </div>

      <table className={s.ftable}>
        <caption className={s.srOnly}>Funil da jornada por etapa, expediente e fora do expediente</caption>
        <thead>
          <tr>
            <th scope="col">Etapa</th>
            <th scope="col">Leads</th>
            <th scope="col" style={{ textAlign: "right" }}>Passou para a próxima</th>
          </tr>
        </thead>
        <tbody onMouseLeave={() => setHover(-1)}>
          {etapas.map((e, i) => (
            <tr key={e.nome} onMouseEnter={() => setHover(i)} className={hover === i ? s.hov : undefined}>
              <th scope="row">{e.nome}</th>
              <td>
                <div className={s.bars}>
                  <div className={s.barRow}><div className={s.bar} style={{ width: largura(e.exp), background: "#6868d7" }} /><span>{n(e.exp)}</span></div>
                  <div className={s.barRow}><div className={s.bar} style={{ width: largura(e.fora), background: "#199e70" }} /><span>{n(e.fora)}</span></div>
                </div>
              </td>
              <td className={s.pass}>
                {i < ultimo && (
                  <div>
                    <span><span className={s.srOnly}>Expediente: </span><span aria-hidden="true" className={s.dot} style={{ background: "#6868d7" }} />{pct(etapas[i + 1].exp, e.exp)}</span>
                    <span><span className={s.srOnly}>Fora: </span><span aria-hidden="true" className={s.dot} style={{ background: "#199e70" }} />{pct(etapas[i + 1].fora, e.fora)}</span>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div role="status" className={s.detail}>{detalhe}</div>
    </section>
  );
}
