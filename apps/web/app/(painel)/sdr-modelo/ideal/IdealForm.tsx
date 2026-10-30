"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import {
  GRUPOS, UNIDADE_TELA, daEdicao, impedimento, mudancas, paraEdicao, somaAtivos, type Comportamento, type Edicao,
} from "@/lib/sdr-modelo";
import { salvarSdrIdeal } from "./actions";
import s from "../modelo.module.css";
import f from "./ideal.module.css";

export interface Historico { versao: number; quando: string; quem: string; mudancas: string[] }

type Aba = "cfg" | "sug" | "hist";

export function IdealForm({ versao, comportamentos, historico }: { versao: number; comportamentos: Comportamento[]; historico: Historico[] }) {
  const router = useRouter();
  const inicial = useMemo(() => comportamentos.map(paraEdicao), [comportamentos]);
  const [aba, setAba] = useState<Aba>("cfg");
  const [rows, setRows] = useState<Edicao[]>(inicial);
  const [msg, setMsg] = useState<{ ok: boolean; texto: string } | null>(null);
  const [pending, start] = useTransition();
  const base = new Map(inicial.map((r) => [r.id, r]));

  const set = (id: string, patch: Partial<Edicao>) => { setMsg(null); setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r))); };
  const lista = mudancas(comportamentos, rows);
  const erro = lista.length ? impedimento(rows) : null;
  const soma = somaAtivos(rows);
  const podeSalvar = lista.length > 0 && !erro && !pending;

  const novo = () => {
    const n = rows.filter((r) => r.novo).length + 1;
    setRows((rs) => [...rs, {
      id: `ia${Date.now().toString(36)}`, grupo: "ia", nome: `Novo comportamento ${n}`, medida: "Nota da IA, de 0 a 10", unidade: "nota",
      lo: "7", hi: "9", melhor: "1", peso: "0", ativo: false, descricao: "", novo: true,
    }]);
  };
  const salvar = () => start(async () => {
    const r = await salvarSdrIdeal(versao, rows.map(daEdicao), lista);
    if (r.erro) setMsg({ ok: false, texto: r.erro });
    else { setMsg({ ok: true, texto: `Versão ${r.versao} salva. Vale a partir de agora.` }); router.refresh(); }
  });

  const nota = msg?.texto ?? (!lista.length ? "Nenhuma mudança." : erro
    ?? `${lista.length} ${lista.length === 1 ? "mudança" : "mudanças"}: ${lista.join("; ")}.`);
  const notaAviso = msg ? !msg.ok : !!erro;

  return (
    <>
      <div role="tablist" aria-label="Seções do SDR Ideal" className={f.tabs}>
        {([["cfg", "Comportamentos e pesos"], ["sug", "Sugestões da IA"], ["hist", "Histórico de versões"]] as const).map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={aba === k} className={f.tab} onClick={() => setAba(k)}>{l}</button>
        ))}
      </div>

      {aba === "cfg" && (
        <section aria-labelledby="sec-cfg" className={f.box}>
          <div className={f.boxHead}>
            <div className={s.headText} style={{ flexGrow: 1 }}>
              <h2 id="sec-cfg" className={f.h2}>Comportamentos e pesos</h2>
              <span className={s.muted12}>Mude o que quiser e salve. Cada vez que salva, nasce uma versão nova, com data e autor.</span>
            </div>
            <div className={`${f.sum} ${soma !== 100 ? f.sumBad : ""}`}>
              <span className={s.muted12}>Soma dos pesos</span>
              <strong>{soma}<small> de 100</small></strong>
            </div>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table className={f.table}>
              <thead>
                <tr>
                  <th scope="col" style={{ width: 64 }}>Ativo</th>
                  <th scope="col">Comportamento</th>
                  <th scope="col" style={{ width: 280 }}>Faixa ideal</th>
                  <th scope="col" style={{ width: 200 }}>Fora da faixa, o que conta como melhor</th>
                  <th scope="col" style={{ width: 250 }}>Peso</th>
                </tr>
              </thead>
              <tbody>
                {GRUPOS.map((g) => [
                  <tr key={g.id} className={s.groupRow}><th scope="rowgroup" colSpan={5}>{g.label}</th></tr>,
                  ...rows.filter((r) => r.grupo === g.id).map((r) => {
                    const b = base.get(r.id);
                    const pesoMudou = !b ? "novo" : Number(r.peso) !== Number(b.peso) ? `era ${b.peso}` : "";
                    const descMudou = r.grupo === "ia" && b && r.descricao.trim() !== b.descricao.trim();
                    return (
                      <tr key={r.id} className={f.row} style={{ opacity: r.ativo ? 1 : 0.55 }}>
                        <td>
                          <button type="button" role="switch" aria-checked={r.ativo} aria-label={`Ativo: ${r.nome}`} className={f.switch} onClick={() => set(r.id, { ativo: !r.ativo })}>
                            <span />
                          </button>
                        </td>
                        <td>
                          {r.grupo === "ia" ? (
                            <div className={f.iaCol}>
                              <input type="text" className={f.inName} value={r.nome} maxLength={80} aria-label="Nome do comportamento" onChange={(e) => set(r.id, { nome: e.target.value })} />
                              <label className={s.lbl} htmlFor={`d-${r.id}`}>O que a IA olha</label>
                              <textarea id={`d-${r.id}`} rows={2} maxLength={1000} className={`${f.inDesc} ${!r.descricao.trim() ? f.inWarn : ""}`} value={r.descricao}
                                onChange={(e) => set(r.id, { descricao: e.target.value })} />
                              <span className={!r.descricao.trim() || descMudou ? f.noteWarn : s.muted12}>
                                {!r.descricao.trim() ? "Escreva o que a IA deve olhar." : descMudou ? "Mudou: as conversas avaliadas a partir de agora usam o texto novo." : "A avaliação pela IA entra numa próxima etapa."}
                              </span>
                            </div>
                          ) : (
                            <div className={s.behName}>{r.nome}<span className={s.muted12} style={{ fontWeight: 400 }}>{r.medida}</span></div>
                          )}
                        </td>
                        <td>
                          <div className={f.range}>
                            <span className={s.muted12}>de</span>
                            <input type="text" inputMode="decimal" className={f.inNum} value={r.lo} aria-label={`${r.nome}: faixa ideal, de`} onChange={(e) => set(r.id, { lo: e.target.value })} />
                            <span className={s.muted12}>a</span>
                            <input type="text" inputMode="decimal" className={f.inNum} value={r.hi} aria-label={`${r.nome}: faixa ideal, até`} onChange={(e) => set(r.id, { hi: e.target.value })} />
                            <span className={s.muted12}>{UNIDADE_TELA[r.unidade] ?? r.unidade}</span>
                          </div>
                        </td>
                        <td>
                          <select className={f.inSel} value={r.melhor} aria-label={`${r.nome}: fora da faixa, o que conta como melhor`} onChange={(e) => set(r.id, { melhor: e.target.value })}>
                            <option value="1">Maior é melhor</option>
                            <option value="-1">Menor é melhor</option>
                            <option value="0">Nenhum: só a faixa</option>
                          </select>
                        </td>
                        <td>
                          <div className={f.weight}>
                            <input type="text" inputMode="numeric" className={f.inNum} style={{ width: 64 }} value={r.peso} aria-label={`Peso de ${r.nome}`} onChange={(e) => set(r.id, { peso: e.target.value })} />
                            <span aria-hidden="true" className={f.wTrack}><span style={{ width: `${Math.min(100, ((Number(r.peso) || 0) / 30) * 100)}%` }} /></span>
                            <span className={pesoMudou ? f.noteWarn : s.muted12}>{pesoMudou}</span>
                          </div>
                        </td>
                      </tr>
                    );
                  }),
                ])}
              </tbody>
            </table>
          </div>
          <div className={f.addBar}>
            <button type="button" className={f.add} onClick={novo}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
              Novo comportamento de conversa
            </button>
            <span className={s.muted12}>Comportamento de conversa novo não precisa de código: a IA passa a avaliar quando a avaliação estiver ligada. Comportamento novo de número precisa de código.</span>
          </div>
          <div className={f.saveBar}>
            <button type="button" className={s.btnPrimary} style={{ cursor: podeSalvar ? "pointer" : "not-allowed", opacity: podeSalvar ? 1 : 0.5 }}
              aria-disabled={!podeSalvar} onClick={() => podeSalvar && salvar()}>
              {pending ? "Salvando…" : `Salvar como versão ${versao + 1}`}
            </button>
            <button type="button" className={s.btnOutline} onClick={() => { setRows(inicial); setMsg(null); }}>Descartar mudanças</button>
            <span role="status" className={notaAviso ? f.noteWarn : msg?.ok ? f.noteOk : s.muted12}>{nota}</span>
          </div>
        </section>
      )}

      {aba === "sug" && (
        <section aria-labelledby="sec-sug" className={f.box} style={{ padding: 16, gap: 6, display: "flex", flexDirection: "column" }}>
          <h2 id="sec-sug" className={f.h2}>Sugestões da IA</h2>
          <span className={s.empty}>
            Toda segunda, a IA vai comparar as conversas que viraram reunião validada com as outras e sugerir ajustes de faixa ou de peso,
            com a justificativa. Nada muda sem aprovação. Essa parte entra numa próxima etapa, depois da avaliação das conversas pela IA.
          </span>
        </section>
      )}

      {aba === "hist" && (
        <section aria-labelledby="sec-hist" className={f.box}>
          <div className={f.boxHead}>
            <div className={s.headText}>
              <h2 id="sec-hist" className={f.h2}>Histórico de versões</h2>
              <span className={s.muted12}>A aderência de cada período usa a versão que estava em uso no fim dele.</span>
            </div>
          </div>
          <table className={f.table}>
            <thead><tr><th scope="col">Versão</th><th scope="col">Em uso</th><th scope="col">Quem</th><th scope="col">O que mudou</th></tr></thead>
            <tbody>
              {historico.map((h) => (
                <tr key={h.versao} className={f.row}>
                  <td style={{ fontWeight: 700, whiteSpace: "nowrap" }}>Versão {h.versao}</td>
                  <td style={{ whiteSpace: "nowrap" }}>{h.quando}</td>
                  <td style={{ whiteSpace: "nowrap" }}>{h.quem}</td>
                  <td><ul style={{ margin: 0, paddingLeft: 16 }}>{h.mudancas.map((m, i) => <li key={i}>{m}</li>)}</ul></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}
