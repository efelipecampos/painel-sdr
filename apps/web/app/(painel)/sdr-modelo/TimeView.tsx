"use client";

import Link from "next/link";
import { useState } from "react";
import { GRUPOS, coletivo, fora, ok, rotulo, type Grupo, type Situacao } from "@/lib/sdr-modelo";
import s from "./modelo.module.css";

export interface TimeSdr { id: string; name: string; aderencia: number | null; base: string }
export interface TimeComp {
  id: string; grupo: Grupo; nome: string; medida: string; peso: number; faixa: string;
  cells: Record<string, { valor: string; situacao: Situacao }>;
}

const UP = "M12 19V5M6 11l6-6l6 6", DOWN = "M12 5v14M6 13l6 6l6-6", CHECK = "M5 12l5 5l9-10", DASH = "M6 12h12";
const icone = (st: Situacao) => (ok(st) ? CHECK : st === "acima" ? UP : st === "abaixo" ? DOWN : DASH);
const cor = (st: Situacao) => (ok(st) ? "#6868d7" : fora(st) ? "#f0a93b" : "#a7abb5");
const primeiro = (n: string) => n.split(" ")[0];

export function TimeView({ sdrs, comps, qs }: { sdrs: TimeSdr[]; comps: TimeComp[]; qs: string }) {
  const [sort, setSort] = useState<"padrao" | "fora">("padrao");
  const [sel, setSel] = useState<string | null>(null);

  const linhas = comps.map((c, i) => ({ ...c, ordem: i, ...coletivo(sdrs.map((d) => c.cells[d.id].situacao)) }));
  const ordenar = (l: typeof linhas) => sort === "padrao" ? l : [...l].sort((a, b) => {
    const d = b.fora / Math.max(1, b.avaliados) - a.fora / Math.max(1, a.avaliados);
    return Math.abs(d) > 0.001 ? d : b.peso - a.peso;
  });
  const coletivos = linhas.filter((l) => l.coletivo);
  const treino = coletivos.length
    ? `${coletivos.map((l) => `${l.nome} (${l.fora} de ${l.avaliados} SDRs fora)`).join(" e ")}. Um treino para o time inteiro resolve mais aqui do que 1:1 separados.`
    : "Nenhum comportamento com metade do time fora da faixa neste período.";

  let detalhe: { titulo: string; texto: string; sdr?: TimeSdr } = { titulo: "Clique numa célula para ver o detalhe.", texto: "" };
  if (sel) {
    const [cid, sid] = sel.split("|");
    const c = comps.find((x) => x.id === cid), d = sdrs.find((x) => x.id === sid);
    if (c && d) {
      const cell = c.cells[d.id];
      const texto = cell.situacao === "amostra_pequena"
        ? "Amostra pequena no período (menos de 3 reuniões ou de 10 respostas). Não entra na nota de aderência."
        : cell.situacao === "sem_dado"
          ? "Sem valor no período ou sem faixa no SDR Ideal. Não entra na nota de aderência."
          : `Valor no período: ${cell.valor}. Faixa ideal: ${c.faixa}. ${cell.situacao === "melhor" ? "Melhor que a faixa: conta como dentro."
            : cell.situacao === "dentro" ? "Dentro da faixa." : cell.situacao === "acima" ? "Fora, acima da faixa." : "Fora, abaixo da faixa."} Peso ${c.peso} na aderência.`;
      detalhe = { titulo: `${primeiro(d.name)} · ${c.nome}`, texto, sdr: d };
    }
  }

  return (
    <>
      <section aria-labelledby="sec-train" className={s.train}>
        <div className={s.trainIcon}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 9l9-5l9 5l-9 5z" /><path d="M7 11v5c3 2 7 2 10 0v-5M21 9v6" /></svg>
        </div>
        <div className={s.trainText}>
          <h2 id="sec-train">Onde treinar o time</h2>
          <span>{treino}</span>
        </div>
        <span className={s.trainNote}>Marcamos &quot;treino coletivo&quot; quando metade dos SDRs avaliados ou mais está fora da faixa.</span>
      </section>

      <div className={s.bar}>
        <div className={s.bar} style={{ gap: 8 }}>
          <span id="lbl-sort" className={s.lbl}>Ordenar comportamentos</span>
          <div role="group" aria-labelledby="lbl-sort" style={{ display: "flex", gap: 8 }}>
            <button type="button" className={s.sortBtn} aria-pressed={sort === "padrao"} onClick={() => setSort("padrao")}>Ordem padrão</button>
            <button type="button" className={s.sortBtn} aria-pressed={sort === "fora"} onClick={() => setSort("fora")}>Mais SDRs fora primeiro</button>
          </div>
        </div>
        <span className={s.grow} />
        <div aria-label="Legenda" className={s.legend}>
          <span><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6868d7" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={CHECK} /></svg>Na faixa ou melhor</span>
          <span><span className={s.legendOut}><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#f0a93b" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={UP} /></svg></span>Fora: acima ou abaixo da faixa</span>
          <span><span className={s.legendSmall} />Amostra pequena: fica fora da nota</span>
        </div>
      </div>

      <div className={s.tableCard}>
        <table className={s.table}>
          <caption className="sr-only">Aderência de cada SDR ao SDR Ideal, por comportamento</caption>
          <thead>
            <tr>
              <th scope="col" className={s.thBeh}>Comportamento</th>
              {sdrs.map((d) => (
                <th key={d.id} scope="col" className={s.thSdr}>
                  <div>
                    <Link href={`/sdr-modelo/${d.id}${qs}`} aria-label={`Abrir o SDR Modelo de ${d.name}`}>{d.name}</Link>
                    <span className={s.muted12}>Aderência</span>
                    <span className={s.score}>{d.aderencia ?? "—"}<small> /100</small></span>
                    <div role="img" aria-label={`Aderência ${d.aderencia ?? 0} de 100`} className={s.track}>
                      <div className={s.fill} style={{ width: `${d.aderencia ?? 0}%` }} />
                    </div>
                    <span className={s.muted12}>{d.base}</span>
                  </div>
                </th>
              ))}
              <th scope="col" className={s.thOut}>SDRs fora da faixa</th>
            </tr>
          </thead>
          <tbody>
            {GRUPOS.map((g) => {
              const rows = ordenar(linhas.filter((l) => l.grupo === g.id));
              if (!rows.length) return null;
              return [
                <tr key={g.id} className={s.groupRow}><th scope="rowgroup" colSpan={sdrs.length + 2}>{g.label}</th></tr>,
                ...rows.map((r) => (
                  <tr key={r.id} className={s.row}>
                    <th scope="row" className={s.rowHead}>
                      <div>
                        <span className={s.rowName}>{r.nome}{r.coletivo && <span className={s.chipColl}>Treino coletivo</span>}</span>
                        <span className={s.muted12}>{r.medida}</span>
                        <span className={s.muted12}>Faixa ideal {r.faixa} · peso {r.peso}</span>
                      </div>
                    </th>
                    {sdrs.map((d) => {
                      const c = r.cells[d.id], key = `${r.id}|${d.id}`, pequena = !ok(c.situacao) && !fora(c.situacao);
                      const aria = `${d.name}, ${r.nome}: ${c.valor}, ${rotulo(c.situacao)} (faixa ${r.faixa})`;
                      return (
                        <td key={d.id} className={s.cellTd}>
                          <button type="button" aria-pressed={sel === key} aria-label={aria} title={aria} onClick={() => setSel(key)}
                            className={`${s.cell} ${fora(c.situacao) ? s.cellOut : ""} ${pequena ? s.cellSmall : ""}`}>
                            <span className={pequena ? s.cellValueSmall : s.cellValue}>{c.valor}</span>
                            <span className={s.cellStatus}>
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={cor(c.situacao)} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={icone(c.situacao)} /></svg>
                              {rotulo(c.situacao)}
                            </span>
                          </button>
                        </td>
                      );
                    })}
                    <td className={s.outTd}>
                      <div>
                        <span>{r.fora} de {r.avaliados}</span>
                        <div role="img" aria-label={`${r.fora} de ${r.avaliados} SDRs fora da faixa`} className={s.outTrack}>
                          <div className={s.fillOut} style={{ width: `${r.avaliados ? (r.fora / r.avaliados) * 100 : 0}%` }} />
                        </div>
                      </div>
                    </td>
                  </tr>
                )),
              ];
            })}
          </tbody>
        </table>
      </div>

      <section aria-live="polite" aria-label="Detalhe da célula escolhida" className={s.detail}>
        <div className={s.detailText}>
          <span className={s.lbl}>Detalhe</span>
          <span className={s.detailTitle}>{detalhe.titulo}</span>
          {detalhe.texto && <span>{detalhe.texto}</span>}
        </div>
        {detalhe.sdr && (
          <div className={s.detailActions}>
            <Link href={`/sdr/${detalhe.sdr.id}`} className={s.btnOutline}>Ver conversas</Link>
            <Link href={`/sdr-modelo/${detalhe.sdr.id}${qs}${sel ? `&c=${sel.split("|")[0]}` : ""}`} className={s.btnPrimary}>
              Abrir o SDR Modelo de {primeiro(detalhe.sdr.name)}
            </Link>
          </div>
        )}
      </section>
    </>
  );
}
