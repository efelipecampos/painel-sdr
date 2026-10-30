"use client";

import { useState } from "react";
import { GRUPOS, avaliado, fora, ok, rotulo, type Grupo, type Situacao } from "@/lib/sdr-modelo";
import { formatDateTime } from "@/lib/time";
import s from "../modelo.module.css";

export interface Exemplo { tipo: "melhorar" | "bom"; lead: string; quando: string; nota: string; link: string | null }
export interface UmComp {
  id: string; grupo: Grupo; nome: string; medida: string; peso: number; unidade: string;
  lo: number | null; hi: number | null; valorNum: number | null; valor: string; faixa: string; situacao: Situacao;
  exemplos: Exemplo[] | null;   // null = comportamento sem conversa de exemplo (contagem do período)
}

const UP = "M12 19V5M6 11l6-6l6 6", DOWN = "M12 5v14M6 13l6 6l6-6", CHECK = "M5 12l5 5l9-10", DASH = "M6 12h12";

/** Distância até a faixa, em palavras: "abaixo da faixa (6% a 8,2%)". */
const distancia = (c: UmComp) => `${c.valor}, ${rotulo(c.situacao)} (${c.faixa})`;

export function UmView({ aderencia, anterior, comps, inicial }: { aderencia: number | null; anterior: string; comps: UmComp[]; inicial: string | null }) {
  const foraLista = comps.filter((c) => fora(c.situacao)).sort((a, b) => b.peso - a.peso);
  const [sel, setSel] = useState<string>(inicial && comps.some((c) => c.id === inicial) ? inicial : (foraLista[0] ?? comps[0]).id);
  const atual = comps.find((c) => c.id === sel) ?? comps[0];
  const nAval = comps.filter((c) => avaliado(c.situacao)).length;
  const nOk = comps.filter((c) => ok(c.situacao)).length;
  const nPeq = comps.filter((c) => c.situacao === "amostra_pequena").length;

  return (
    <>
      <div className={s.top}>
        <section aria-labelledby="sec-score" className={s.card}>
          <h2 id="sec-score" className={s.cardH2}>Aderência ao SDR Ideal</h2>
          <div className={s.bigScore}>
            <strong>{aderencia ?? "—"}</strong><span className={s.muted12}>/100</span>
            <span className={s.prev}>{anterior}</span>
          </div>
          <div role="img" aria-label={`Aderência ${aderencia ?? 0} de 100`} className={s.track8}>
            <div className={s.fill8} style={{ width: `${aderencia ?? 0}%` }} />
          </div>
          <span className={s.muted12}>
            {nOk} de {nAval} comportamentos avaliados na faixa ou melhores{nPeq ? ` · ${nPeq} com amostra pequena (fora da nota)` : ""}
          </span>
        </section>

        <section aria-labelledby="sec-start" className={`${s.card} ${s.start}`}>
          <div className={s.startHead}>
            <div className={s.startIcon}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 9l9-5l9 5l-9 5z" /><path d="M7 11v5c3 2 7 2 10 0v-5" /></svg>
            </div>
            <h2 id="sec-start">{foraLista.length ? "Por onde começar o treino" : "Nada fora da faixa"}</h2>
            <span className={s.prev} style={{ marginLeft: "auto", fontSize: 12, color: "#a7abb5" }}>Fora da faixa, do maior peso para o menor</span>
          </div>
          {foraLista.length ? (
            <ol className={s.startList}>
              {foraLista.map((c, i) => (
                <li key={c.id}>
                  <button type="button" className={s.startBtn} onClick={() => setSel(c.id)}>
                    <span className={s.startN}>{i + 1}</span>
                    <span className={s.startName}>{c.nome}<span className={s.muted12}>{distancia(c)}</span></span>
                    <span className={s.muted12} style={{ whiteSpace: "nowrap" }}>peso {c.peso}</span>
                  </button>
                </li>
              ))}
            </ol>
          ) : <span className={s.empty}>Todos os comportamentos avaliados estão na faixa ou melhores que ela.</span>}
        </section>
      </div>

      <div className={s.bottom}>
        <section aria-labelledby="sec-beh" className={s.behCard}>
          <div className={s.behHead}>
            <h2 id="sec-beh">Comportamentos</h2>
            <div aria-hidden="true" className={s.behLegend}>
              <span><span className={s.swBand} />Faixa ideal</span>
              <span><span className={s.swOk} />Valor na faixa ou melhor</span>
              <span><span className={s.swOut} />Valor fora</span>
            </div>
          </div>
          <div role="list">
            {GRUPOS.map((g) => {
              const rows = comps.filter((c) => c.grupo === g.id);
              if (!rows.length) return null;
              return (
                <div key={g.id} role="presentation">
                  <div role="presentation" className={s.behGroup}>{g.label}</div>
                  {rows.map((c) => <Linha key={c.id} c={c} on={c.id === atual.id} pick={() => setSel(c.id)} />)}
                </div>
              );
            })}
          </div>
        </section>

        <Exemplos c={atual} />
      </div>
    </>
  );
}

function Linha({ c, on, pick }: { c: UmComp; on: boolean; pick: () => void }) {
  // régua: de 0 até um pouco além do maior entre o valor e a faixa
  const max = Math.max(Number(c.hi ?? 0) * 1.5, (c.valorNum ?? 0) * 1.1, 1);
  const pos = (v: number) => `${Math.min(100, Math.max(0, (v / max) * 100))}%`;
  const pequena = !avaliado(c.situacao);
  const chip = ok(c.situacao) ? s.chipOk : fora(c.situacao) ? s.chipOut : s.chipSmall;
  const icon = ok(c.situacao) ? CHECK : c.situacao === "acima" ? UP : c.situacao === "abaixo" ? DOWN : DASH;
  return (
    <div role="listitem">
      <button type="button" className={s.behRow} aria-pressed={on} onClick={pick}
        aria-label={`${c.nome}: ${c.valor}, ${rotulo(c.situacao)}, faixa ${c.faixa}, peso ${c.peso}`}>
        <span className={s.behName}>{c.nome}<span className={s.muted12} style={{ fontWeight: 400 }}>{c.medida}</span></span>
        <span aria-hidden="true" className={s.gauge}>
          <span className={s.gTrack} />
          {c.lo != null && c.hi != null && <span className={s.gBand} style={{ left: pos(Number(c.lo)), width: `calc(${pos(Number(c.hi))} - ${pos(Number(c.lo))})` }} />}
          {c.valorNum != null && !pequena && <span className={s.gDot} style={{ left: pos(c.valorNum), background: ok(c.situacao) ? "#6868d7" : "#f0a93b" }} />}
        </span>
        <span className={s.behVal}>
          <strong style={pequena ? { color: "#a7abb5" } : undefined}>{c.valor}</strong>
          <span className={s.muted12} style={{ whiteSpace: "nowrap" }}>faixa {c.faixa}</span>
        </span>
        <span className={`${s.chip} ${chip}`}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={icon} /></svg>
          {rotulo(c.situacao)}
        </span>
        <span className={s.behWeight}>peso {c.peso}</span>
      </button>
    </div>
  );
}

function Exemplos({ c }: { c: UmComp }) {
  const ruins = (c.exemplos ?? []).filter((e) => e.tipo === "melhorar");
  const bons = (c.exemplos ?? []).filter((e) => e.tipo === "bom");
  const resumo = `${c.valor} no período. Faixa ideal ${c.faixa}. ${rotulo(c.situacao).replace(/^./, (x) => x.toUpperCase())}.`;
  return (
    <section aria-labelledby="sec-ex" aria-live="polite" className={`${s.card} ${s.ex}`}>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span className={s.lbl}>Exemplos de conversas</span>
        <h2 id="sec-ex" className={s.exTitle}>{c.nome}</h2>
        <span style={{ fontSize: 14, lineHeight: "20px" }}>{resumo}</span>
      </div>
      {c.exemplos === null ? (
        <span className={s.empty}>Este comportamento é uma contagem do período; não tem uma conversa de exemplo. Veja os chats na tela do SDR.</span>
      ) : (
        <>
          <Lista titulo="A melhorar" cls={s.exBad} icon="M12 9v4M12 17h.01" itens={ruins} vazio="Nenhum caso a melhorar no período." />
          <Lista titulo="Bom exemplo" cls={s.exGood} icon={CHECK} itens={bons} vazio="Nenhum bom exemplo no período." />
        </>
      )}
      <span className={s.exFoot}>Os links abrem a conversa no Poli. O painel não mostra telefone nem o texto das mensagens.</span>
    </section>
  );
}

function Lista({ titulo, cls, icon, itens, vazio }: { titulo: string; cls: string; icon: string; itens: Exemplo[]; vazio: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <h3 className={`${s.exH3} ${cls}`}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={icon} /></svg>
        {titulo}
      </h3>
      {itens.length === 0 && <span className={s.empty}>{vazio}</span>}
      {itens.map((e, i) => (
        <div key={i} className={s.exItem}>
          <div>
            <span className={s.exLead}>{e.lead} <span>· {formatDateTime(e.quando)}</span></span>
            <span>{e.nota}</span>
          </div>
          {e.link && <a href={e.link} target="_blank" rel="noreferrer" className={s.exLink} aria-label={`Abrir a conversa de ${e.lead} no Poli`}>Abrir no Poli</a>}
        </div>
      ))}
    </div>
  );
}
