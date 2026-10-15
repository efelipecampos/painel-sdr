"use client";

// Jornada · Regras: reproduz design/JornadaRegras.dc.html (status da jornada, telefone de teste, aviso de limite,
// tabela de regras, editor com prévia e histórico, diálogo de pausa geral).
import { useEffect, useMemo, useState, useTransition } from "react";
import { previa, variaveis, variaveisDesconhecidas, type Janela } from "@painel/shared/jornada";
import { alternarRegra, ativarRegra, enviarTeste, pausarJornada, salvarRegra, salvarTelefone, textoTemplate, type Resultado } from "./actions";
import s from "./jornada.module.css";

export interface TemplateOpcao { uuid: string; key: string; status: string | null; body: string | null; buttons: string[]; recente: boolean }
export interface RegraLinha {
  id: string; origin: string; button: string; janela: Janela; dest: string;
  status: "teste" | "ativa" | "pausada" | "limite"; limit: number | null;
  enviados: number; falhas: number; limiteEm: string | null;
  historico: { quando: string; oque: string }[];
}

const JANELA: Record<Janela, string> = { expediente: "Expediente", fora: "Fora do expediente", sempre: "Sempre" };
const STATUS: Record<RegraLinha["status"], string> = { teste: "Em teste", ativa: "Ativa", pausada: "Pausada", limite: "Pausada: bateu o limite" };
const VAR_NOME: Record<string, string> = {
  contact_first_name: "primeiro nome do contato", contact_name: "nome do contato", operator_name: "primeiro nome da SDR dona do lead",
};
const LEAD_EXEMPLO = "Renata Exemplo";

interface Form { origin: string; button: string; janela: Janela; dest: string; limit: number | null }

function Badge({ status }: { status: RegraLinha["status"] }) {
  return <span className={`${s.badge} ${s[`b_${status}`]}`}>{STATUS[status]}</span>;
}

export function RegrasView(p: {
  regras: RegraLinha[]; templates: TemplateOpcao[]; pausada: boolean; pausaInfo: string;
  telefone: string; telefoneInfo: string; expediente: string; sdrExemplo: string;
}) {
  const [pending, start] = useTransition();
  const porUuid = useMemo(() => new Map(p.templates.map((t) => [t.uuid, t])), [p.templates]);
  const nomeTpl = (uuid: string) => porUuid.get(uuid)?.key ?? "(template fora da lista do Poli)";
  const comBotoes = useMemo(() => p.templates.filter((t) => t.buttons.length), [p.templates]);
  const validados = useMemo(() => p.templates.filter((t) => t.status === "VALIDATED"), [p.templates]);

  const formDe = (r: RegraLinha): Form => ({ origin: r.origin, button: r.button, janela: r.janela, dest: r.dest, limit: r.limit });
  const novoForm = (): Form => {
    const o = comBotoes[0];
    return { origin: o?.uuid ?? "", button: o?.buttons[0] ?? "", janela: "expediente", dest: validados[0]?.uuid ?? "", limit: null };
  };
  const [editando, setEditando] = useState<string | null>(p.regras[0]?.id ?? null);
  const atual = p.regras.find((r) => r.id === editando) ?? null;
  const [form, setForm] = useState<Form>(atual ? formDe(atual) : novoForm());
  const [msg, setMsg] = useState<Resultado | null>(null);
  const [testeMsg, setTesteMsg] = useState<Resultado | null>(null);
  const [fone, setFone] = useState(p.telefone);
  const [foneMsg, setFoneMsg] = useState<Resultado | null>(null);
  const [confirmar, setConfirmar] = useState(false);
  const [textos, setTextos] = useState<Record<string, { body: string; buttons: string[] }>>({});

  // Template sem texto na carga da página: busca quando é escolhido.
  const dest = porUuid.get(form.dest);
  const destTexto = dest?.body ?? textos[form.dest]?.body ?? null;
  const destBotoes = dest?.buttons ?? textos[form.dest]?.buttons ?? [];
  useEffect(() => {
    if (form.dest && destTexto === null) textoTemplate(form.dest).then((t) => t && setTextos((x) => ({ ...x, [form.dest]: t })));
  }, [form.dest, destTexto]);

  const carregar = (r: RegraLinha | null) => {
    setEditando(r?.id ?? null);
    setForm(r ? formDe(r) : novoForm());
    setMsg(null);
    setTesteMsg(null);
  };
  const rodar = (fn: () => Promise<Resultado & { id?: string }>, alvo: (r: Resultado) => void = setMsg) =>
    start(async () => {
      const r = await fn();
      alvo(r);
      if (r.ok && "id" in r && r.id) setEditando(r.id);
    });

  const ativas = p.regras.filter((r) => r.status === "ativa").length;
  const emTeste = p.regras.filter((r) => r.status === "teste").length;
  const enviadosHoje = p.regras.reduce((t, r) => t + r.enviados, 0);
  const limitada = p.regras.find((r) => r.status === "limite");

  const origem = porUuid.get(form.origin);
  const ruins = destTexto ? variaveisDesconhecidas(destTexto) : [];
  const vars = destTexto ? [...new Set(variaveis(destTexto))] : [];
  const podeAtivar = !!atual && atual.status === "teste" && !!destTexto && ruins.length === 0;
  const podeTestar = !!p.telefone && !!destTexto && ruins.length === 0;
  const temLimite = form.limit !== null;
  const textoPrevia = destTexto
    ? previa(destTexto, { leadNome: LEAD_EXEMPLO, sdrNome: p.sdrExemplo })
    : "Carregando o texto do template…";

  return (
    <>
      <section aria-labelledby="sec-status" className={`${s.statusBox} ${p.pausada ? s.statusBoxPaused : ""}`}>
        <div className={`${s.statusIcon} ${p.pausada ? s.statusIconPaused : ""}`}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d={p.pausada ? "M9 6v12M15 6v12" : "M7 5l12 7l-12 7z"} />
          </svg>
        </div>
        <div className={s.statusText}>
          <h2 id="sec-status">{p.pausada ? "Jornada pausada" : "Jornada ativa"}</h2>
          <span>
            {p.pausada
              ? `${p.pausaInfo} Nenhuma regra envia até alguém retomar.`
              : `${ativas} ${ativas === 1 ? "regra ativa" : "regras ativas"} e ${emTeste} em teste · ${enviadosHoje} envios hoje · o painel confere cliques novos a cada 30 s.`}
          </span>
        </div>
        <button type="button" onClick={() => setConfirmar(true)} className={`${s.pauseBtn} ${p.pausada ? s.pauseBtnResume : ""}`}>
          {p.pausada ? "Retomar jornada" : "Pausar jornada"}
        </button>
      </section>

      <section aria-labelledby="sec-test" className={s.testBox}>
        <div className={s.testIcon}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="6" y="2" width="12" height="20" rx="2" /><path d="M11 18h2" /></svg>
        </div>
        <label id="sec-test" htmlFor="f-testphone" className={s.testLabel}>Telefone de teste</label>
        <input id="f-testphone" type="tel" inputMode="tel" placeholder="(62) 9 0000-0000" value={fone} onChange={(e) => setFone(e.target.value)} className={s.phone} />
        <button type="button" disabled={pending} onClick={() => rodar(() => salvarTelefone(fone), setFoneMsg)} className={s.btnPrimary}>Salvar</button>
        <span className={foneMsg && !foneMsg.ok ? s.msgErr : p.telefone ? s.note : s.noteWarn}>
          {foneMsg && !foneMsg.ok
            ? foneMsg.msg
            : p.telefone
              ? `Salvo em ${p.telefoneInfo}. Regras em teste mandam a mensagem para este número, pela API da Poli, em vez de mandar para o lead.`
              : "Sem telefone de teste, as regras em teste não enviam nada."}
        </span>
      </section>

      {limitada && (
        <div role="status" className={s.limitAlert}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f0a93b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 9v4M12 17h.01M10.3 3.9L2 18a2 2 0 0 0 1.7 3h16.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /></svg>
          <span>A regra &quot;{nomeTpl(limitada.origin)} · {limitada.button}&quot; bateu o limite de {limitada.limit} envios por dia às {limitada.limiteEm} e parou sozinha. Confira o histórico antes de retomar.</span>
          <button type="button" onClick={() => carregar(limitada)} className={s.smallBtn}>Ver regra</button>
        </div>
      )}

      <div className={s.grid}>
        <section aria-labelledby="sec-rules" className={s.card}>
          <div className={s.cardHead}>
            <div>
              <h2 id="sec-rules" className={s.h2}>Regras</h2>
              <span className={s.note}>O envio sai pelo WhatsApp em nome da SDR dona do lead. Se alguém da equipe já escreveu para o lead depois do clique, o painel não envia.</span>
            </div>
            <button type="button" onClick={() => carregar(null)} className={s.btnPrimary}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
              Nova regra
            </button>
          </div>
          <table className={s.table}>
            <thead>
              <tr>
                <th scope="col">Quando o lead clicar em</th>
                <th scope="col">Horário</th>
                <th scope="col">Enviar</th>
                <th scope="col">Situação</th>
                <th scope="col" className={s.right}>Hoje</th>
                <th scope="col" className={s.right}>Ações</th>
              </tr>
            </thead>
            <tbody>
              {p.regras.map((r) => {
                const pausada = r.status === "pausada" || r.status === "limite";
                const rotulo = pausada ? "Retomar" : "Pausar";
                return (
                  <tr key={r.id} className={editando === r.id ? s.rowOn : undefined}>
                    <td><div className={s.origin}><span className={s.originName}>{nomeTpl(r.origin)}</span><span className={s.pill}>{r.button}</span></div></td>
                    <td>{JANELA[r.janela]}</td>
                    <td className={s.dest}>{nomeTpl(r.dest)}</td>
                    <td><Badge status={r.status} /></td>
                    <td className={s.right}>
                      <div className={s.today}>
                        <b>{r.enviados} {r.status === "teste" ? "para teste" : "envios"}</b>
                        <span className={r.falhas ? s.failsOn : s.fails}>{r.falhas ? `${r.falhas} ${r.falhas === 1 ? "falha" : "falhas"}` : "sem falhas"}</span>
                      </div>
                    </td>
                    <td>
                      <div className={s.actions}>
                        <button type="button" onClick={() => carregar(r)} aria-label={`Editar regra ${r.button} em ${nomeTpl(r.origin)}`} className={s.ghostSm}>Editar</button>
                        <button type="button" disabled={pending} onClick={() => rodar(() => alternarRegra(r.id))} aria-label={`${rotulo} regra ${r.button} em ${nomeTpl(r.origin)}`} className={s.smallBtn}>{rotulo}</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!p.regras.length && <div className={s.empty}>Nenhuma regra ainda. Use &quot;Nova regra&quot; para criar a primeira; ela nasce em teste.</div>}
          <div className={s.legend}><span>Em teste: só envia para o telefone de teste.</span><span>Ativa: envia para os leads.</span><span>Pausada: não envia.</span></div>
        </section>

        <section aria-labelledby="sec-edit" className={s.editor}>
          <div className={s.editorHead}>
            <h2 id="sec-edit" className={s.h2}>{atual ? "Editar regra" : "Nova regra"}</h2>
            {atual ? <Badge status={atual.status} /> : <span className={`${s.badge} ${s.b_teste}`}>Nova: nasce em teste</span>}
          </div>

          <div className={s.two}>
            <div className={s.field}>
              <label htmlFor="f-origin" className={s.lbl}>1. Template de origem</label>
              <select id="f-origin" value={form.origin} className={s.select}
                onChange={(e) => { const o = porUuid.get(e.target.value); setForm({ ...form, origin: e.target.value, button: o?.buttons[0] ?? "" }); }}>
                <Opcoes lista={comBotoes} />
              </select>
            </div>
            <div className={s.field}>
              <label htmlFor="f-dest" className={s.lbl}>4. Template a enviar</label>
              <select id="f-dest" value={form.dest} className={s.select} onChange={(e) => { setTesteMsg(null); setForm({ ...form, dest: e.target.value }); }}>
                <Opcoes lista={validados} />
              </select>
            </div>
          </div>

          <div className={s.field}>
            <span id="lbl-btn" className={s.lbl}>2. Botão em que o lead clicou</span>
            <div role="group" aria-labelledby="lbl-btn" className={s.chips}>
              {(origem?.buttons ?? []).map((b) => (
                <button key={b} type="button" aria-pressed={form.button === b} onClick={() => setForm({ ...form, button: b })} className={`${s.chip} ${form.button === b ? s.chipOn : ""}`}>{b}</button>
              ))}
            </div>
          </div>

          <div className={s.field}>
            <span id="lbl-when" className={s.lbl}>3. Horário do clique</span>
            <div role="group" aria-labelledby="lbl-when" className={s.chips}>
              {(Object.keys(JANELA) as Janela[]).map((k) => (
                <button key={k} type="button" aria-pressed={form.janela === k} onClick={() => setForm({ ...form, janela: k })} className={`${s.chip} ${form.janela === k ? s.chipOn : ""}`}>{JANELA[k]}</button>
              ))}
            </div>
            <span className={s.note}>Expediente = horário comercial das Configurações ({p.expediente}).</span>
          </div>

          <div className={s.field} style={{ gap: 8 }}>
            <span className={s.lbl}>Prévia do que o lead recebe <span>(variáveis com um lead de exemplo)</span></span>
            <div className={s.phoneMock}>
              <div className={s.bubble}>{textoPrevia}</div>
              {destBotoes.map((b) => <div key={b} className={s.bubbleBtn}>{b}</div>)}
              <span className={s.note}>Enviado em nome da SDR dona do lead · Ex.: {p.sdrExemplo}</span>
            </div>
            <div className={s.vars}>
              {vars.map((v) => (
                <span key={v} className={ruins.includes(v) ? s.noteWarn : s.note}>
                  {ruins.includes(v)
                    ? `[${v}]: o painel não sabe preencher. A regra não pode ser ativada com este template.`
                    : `[${v}] = ${VAR_NOME[v]} (exemplo: ${v === "operator_name" ? p.sdrExemplo.split(" ")[0] : v === "contact_name" ? LEAD_EXEMPLO : "Renata"}). O painel preenche.`}
                </span>
              ))}
            </div>
            <div className={s.row}>
              <button type="button" aria-disabled={!podeTestar} disabled={pending}
                onClick={() => podeTestar && rodar(() => enviarTeste(form.dest), setTesteMsg)} className={`${s.sendTest} ${podeTestar ? "" : s.sendTestOff}`}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4z" /></svg>
                Enviar esta mensagem para o telefone de teste
              </button>
              <span role="status" className={testeMsg && !testeMsg.ok ? s.msgErr : s.note}>
                {testeMsg ? testeMsg.msg : !p.telefone ? "Cadastre o telefone de teste acima." : ruins.length ? "Corrija a variável antes de enviar." : `Vai para ${p.telefone}.`}
              </span>
            </div>
          </div>

          {atual?.status === "teste" && (
            <div className={s.info}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}><circle cx="12" cy="12" r="9" /><path d="M12 8h.01M11 12h1v5h1" /></svg>
              <span>Ao ativar, desligue no n8n a regra equivalente no mesmo dia. Senão o lead recebe em dobro.</span>
            </div>
          )}

          <div className={s.field}>
            <span id="lbl-limit" className={s.lbl}>Limite de envios por dia</span>
            <div role="group" aria-labelledby="lbl-limit" className={s.chips}>
              <button type="button" aria-pressed={!temLimite} onClick={() => setForm({ ...form, limit: null })} className={`${s.chip} ${!temLimite ? s.chipOn : ""}`}>Sem limite</button>
              <button type="button" aria-pressed={temLimite} onClick={() => !temLimite && setForm({ ...form, limit: 100 })} className={`${s.chip} ${temLimite ? s.chipOn : ""}`}>Limitar</button>
              {temLimite && (
                <>
                  <input id="f-limit" type="number" min={1} aria-label="Envios por dia" value={form.limit ?? ""} onChange={(e) => setForm({ ...form, limit: Number(e.target.value) })} className={s.limitInput} />
                  <span className={s.note}>por dia. Passou disso, a regra pausa sozinha.</span>
                </>
              )}
            </div>
          </div>

          <div className={s.footer}>
            <button type="button" disabled={pending} onClick={() => rodar(() => salvarRegra({ id: atual?.id ?? null, ...form }))} className={s.btnSecondary}>
              {atual ? "Salvar alterações" : "Criar em teste"}
            </button>
            {atual?.status === "teste" && (
              <button type="button" aria-disabled={!podeAtivar} disabled={pending} onClick={() => podeAtivar && rodar(() => ativarRegra(atual.id))} className={`${s.btnActivate} ${podeAtivar ? "" : s.btnActivateOff}`}>Ativar regra</button>
            )}
            <div style={{ flexGrow: 1 }} />
            <button type="button" onClick={() => carregar(atual)} className={s.btnGhost}>Cancelar</button>
          </div>
          {msg && <span role="status" className={msg.ok ? s.msg : s.msgErr}>{msg.msg}</span>}

          {atual && (
            <div className={s.history}>
              <h3>Histórico desta regra</h3>
              <ol>
                {atual.historico.map((h, i) => <li key={i}><span>{h.quando}</span><span>{h.oque}</span></li>)}
              </ol>
            </div>
          )}
        </section>
      </div>

      {confirmar && (
        <div className={s.overlay}>
          <div role="alertdialog" aria-modal="true" aria-labelledby="dlg-t" aria-describedby="dlg-d" className={s.dialog}>
            <h2 id="dlg-t">{p.pausada ? "Retomar a jornada?" : "Pausar a jornada inteira?"}</h2>
            <p id="dlg-d">
              {p.pausada
                ? "As regras ativas voltam a enviar a partir do próximo ciclo (até 30 s). Cliques feitos durante a pausa não são enviados."
                : "Nenhuma regra envia mais nada a partir do próximo ciclo (até 30 s), inclusive as em teste. Use quando algo estiver errado. Quem pausou e quando fica registrado."}
            </p>
            <div className={s.dialogBtns}>
              <button type="button" onClick={() => setConfirmar(false)} className={s.btnGhost}>Cancelar</button>
              <button type="button" disabled={pending} onClick={() => rodar(() => pausarJornada(!p.pausada), (r) => { setMsg(r); setConfirmar(false); })}
                className={`${s.dialogBtn} ${p.pausada ? s.dialogBtnResume : ""}`}>{p.pausada ? "Retomar" : "Pausar tudo"}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** Templates usados no último mês primeiro; os demais em seguida, em ordem alfabética. */
function Opcoes({ lista }: { lista: TemplateOpcao[] }) {
  const recentes = lista.filter((t) => t.recente), outros = lista.filter((t) => !t.recente);
  return (
    <>
      {recentes.length > 0 && <optgroup label="Usados nos últimos 30 dias">{recentes.map((t) => <option key={t.uuid} value={t.uuid}>{t.key}</option>)}</optgroup>}
      <optgroup label="Outros templates">{outros.map((t) => <option key={t.uuid} value={t.uuid}>{t.key}</option>)}</optgroup>
    </>
  );
}
