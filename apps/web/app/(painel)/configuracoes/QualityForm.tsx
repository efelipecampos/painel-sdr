"use client";

import { useState } from "react";
import { saveQuality } from "./actions";

export interface QualityCriterion { id: string | null; name: string; description: string; weight: number }

let nextKey = 0;
const withKey = (c: QualityCriterion) => ({ ...c, key: `k${nextKey++}` });

// Critérios e contexto da nota de qualidade (Fase 7c). Formulário próprio: salvar aqui faz os leads serem avaliados de novo.
export function QualityForm({ context, criteria }: { context: string; criteria: QualityCriterion[] }) {
  const [ctx, setCtx] = useState(context);
  const [list, setList] = useState(() => criteria.map(withKey));
  const set = (key: string, patch: Partial<QualityCriterion>) => setList(list.map((c) => (c.key === key ? { ...c, ...patch } : c)));
  const total = list.reduce((t, c) => t + (c.weight > 0 ? c.weight : 0), 0);

  return (
    <form action={saveQuality} style={{ display: "flex", flexDirection: "column", gap: 16 }}
      onSubmit={(e) => {
        if (!confirm("Ao salvar, todos os leads voltam para a fila e são avaliados de novo com os critérios novos, até 300 por dia, na rodada das 05:00. Continuar?")) e.preventDefault();
      }}>
      <input type="hidden" name="criteria" value={JSON.stringify(list.map(({ id, name, description, weight }) => ({ id, name, description, weight })))} />

      <section className="card" aria-labelledby="ql">
        <h2 id="ql" className="card-title">Qualidade do lead</h2>
        <p className="muted" style={{ margin: 0 }}>
          Uma vez por dia, às 05:00, o Claude lê as conversas com mensagem nova do lead e dá uma nota de 0 a 100 conforme os critérios abaixo.
          A qualidade da carteira é a média das notas dos leads do SDR.
        </p>

        <label className="lbl" htmlFor="quality_context">Contexto para o Claude</label>
        <textarea id="quality_context" name="quality_context" className="field" rows={6} maxLength={3000} value={ctx} onChange={(e) => setCtx(e.target.value)}
          placeholder="O que a Poli vende, quem é o cliente ideal e o que torna um lead bom ou ruim." />

        <h3 style={{ margin: "8px 0 0", fontSize: 14 }}>Critérios</h3>
        <p className="muted" style={{ margin: 0 }}>
          Peso de 1 a 10, relativo entre os critérios. Ao lado aparece quanto cada um vale na nota.
        </p>
        {list.map((c, i) => (
          <div key={c.key} style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 12, borderTop: i ? "1px solid var(--border-card)" : undefined }}>
            <div className="group">
              <label className="lbl" htmlFor={`${c.key}-n`}>Nome</label>
              <input id={`${c.key}-n`} className="field" style={{ flex: 1, minWidth: 160 }} maxLength={60} value={c.name}
                onChange={(e) => set(c.key, { name: e.target.value })} />
              <label className="lbl" htmlFor={`${c.key}-w`}>Peso</label>
              <input id={`${c.key}-w`} type="number" min={1} max={10} className="field" style={{ width: 70 }} value={c.weight || ""}
                onChange={(e) => set(c.key, { weight: Number(e.target.value) || 0 })} />
              <span className="muted" style={{ width: 90 }}>{total && c.weight > 0 ? `${Math.round((c.weight / total) * 100)}% da nota` : ""}</span>
              <button type="button" className="btn small" disabled={list.length <= 1} aria-label={`Remover critério ${c.name || "sem nome"}`}
                onClick={() => setList(list.filter((x) => x.key !== c.key))}>Remover</button>
            </div>
            <label className="lbl" htmlFor={`${c.key}-d`}>O que o Claude deve observar na conversa</label>
            <textarea id={`${c.key}-d`} className="field" rows={2} maxLength={600} value={c.description}
              onChange={(e) => set(c.key, { description: e.target.value })} />
          </div>
        ))}
        <button type="button" className="btn small" style={{ alignSelf: "flex-start" }} disabled={list.length >= 8}
          onClick={() => setList([...list, withKey({ id: null, name: "", description: "", weight: 2 })])}>Adicionar critério</button>

        <h3 style={{ margin: "8px 0 0", fontSize: 14 }}>Leads que não recebem nota</h3>
        <p className="muted" style={{ margin: 0 }}>
          Quem escreveu menos de 2 mensagens (resposta automática não conta), quem já é cliente e quem não deu informação sobre nenhum critério.
          Critério sem informação na conversa fica fora da média. Esses leads aparecem como &quot;sem avaliação&quot;.
        </p>
      </section>

      <div className="group">
        <span className="spacer" />
        <button type="submit" className="btn primary">Salvar critérios</button>
      </div>
    </form>
  );
}
