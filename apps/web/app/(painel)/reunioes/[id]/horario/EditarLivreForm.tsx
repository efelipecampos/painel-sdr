"use client";

import { useActionState, useState, useTransition } from "react";
import { conferirEdicaoLivre, editarLivre, type CloserLivre } from "../../actions";

// Gestor e admin: data, hora, duração e closer livres. O painel só avisa (passado, fora do expediente, closer ocupado).
export function EditarLivreForm({ id, initialLocal, initialDuration, closerId }: { id: string; initialLocal: string; initialDuration: number; closerId: string }) {
  const [pending, start] = useTransition();
  const [local, setLocal] = useState(initialLocal);
  const [duration, setDuration] = useState(initialDuration);
  const [closer, setCloser] = useState(closerId);
  const [check, setCheck] = useState<{ erro: string | null; avisos: string[]; closers: CloserLivre[] } | null>(null);
  const [state, action, saving] = useActionState(editarLivre, {});

  const conferir = (l: string, d: number) => start(async () => { setCheck(await conferirEdicaoLivre(id, l, d)); });
  const escolhido = check?.closers.find((c) => c.id === closer);
  const mudouCloser = closer !== closerId;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <section className="card" style={{ gap: 10 }}>
        <div className="group" style={{ flexWrap: "wrap" }}>
          <span className="lbl">Início</span>
          <input type="datetime-local" className="field" aria-label="Data e hora de início" value={local}
            onChange={(e) => { if (e.target.value) { setLocal(e.target.value); setCheck(null); } }} />
          <input type="number" className="field" style={{ width: 90 }} min={1} max={1440} aria-label="Duração em minutos" value={duration}
            onChange={(e) => { setDuration(Number(e.target.value) || 30); setCheck(null); }} />
          <span className="muted">min</span>
          <button type="button" className="btn small" disabled={!local || pending} onClick={() => conferir(local, duration)}>
            {pending ? "Consultando as agendas…" : "Conferir agenda"}
          </button>
        </div>
        {check?.erro && <div className="alert" role="alert">{check.erro}</div>}
        {check && !check.erro && (
          <>
            {check.avisos.length > 0 && <div role="status" style={{ border: "1px solid var(--stale)", color: "var(--stale)", borderRadius: "var(--radius-sm)", padding: "10px 12px" }}>Atenção (não impede salvar): {check.avisos.join("; ")}</div>}
            <fieldset style={{ border: 0, padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 6 }}>
              <legend className="lbl" style={{ marginBottom: 6 }}>Closer</legend>
              {check.closers.map((c) => (
                <label key={c.id} className="group" style={{ gap: 8 }}>
                  <input type="radio" name="closer-escolha" value={c.id} checked={closer === c.id} onChange={() => setCloser(c.id)} />
                  <span><strong>{c.name}</strong>{c.atual ? " (atual)" : ""}</span>
                  <span className={c.livre ? "muted" : undefined} style={c.livre ? undefined : { color: "var(--stale)" }}>· {c.situacao}</span>
                </label>
              ))}
            </fieldset>
          </>
        )}
      </section>
      <form action={action} className="group" style={{ flexWrap: "wrap" }}>
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="local" value={local} />
        <input type="hidden" name="duration" value={duration} />
        <input type="hidden" name="closer" value={closer} />
        {mudouCloser && <input name="motivo" className="field" style={{ flex: 1, minWidth: 220 }} placeholder="Motivo da troca de closer (opcional)" aria-label="Motivo da troca de closer" />}
        {state.erro && <div className="alert" role="alert" style={{ flex: "1 1 100%" }}>{state.erro}</div>}
        <span className="spacer" />
        {escolhido && !escolhido.livre && <span className="muted">Vai ficar sobreposto na agenda de {escolhido.name}.</span>}
        <button type="submit" className="btn primary" disabled={!check || !!check.erro || saving}>
          {saving ? "Salvando…" : "Salvar alterações"}
        </button>
      </form>
    </div>
  );
}
