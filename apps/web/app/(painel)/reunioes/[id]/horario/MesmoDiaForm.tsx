"use client";

import { useActionState, useState, useTransition } from "react";
import { conferirMesmoDia, mudarMesmoDia } from "../../actions";

// SDR (2026-10-30): a reunião de hoje vai para outro horário de hoje com o mesmo closer, inclusive até 30 min atrás
// (o cliente pediu para antecipar e o closer topou). Agenda ocupada não bloqueia: o painel só avisa.
export function MesmoDiaForm({ id, day, initialDuration, closerName }: { id: string; day: string; initialDuration: number; closerName: string }) {
  const [pending, start] = useTransition();
  const [hora, setHora] = useState("");
  const [duration, setDuration] = useState(initialDuration);
  const [motivo, setMotivo] = useState("");
  const [check, setCheck] = useState<{ erro: string | null; situacao: string } | null>(null);
  const [state, action, saving] = useActionState(mudarMesmoDia, {});
  const local = hora ? `${day}T${hora}` : "";

  return (
    <section className="card" style={{ gap: 10 }}>
      <h2 className="lbl" style={{ margin: 0 }}>Hoje, com o mesmo closer ({closerName})</h2>
      <p className="muted" style={{ margin: 0 }}>
        Para quando o cliente pede outro horário hoje e o closer confirma. Pode ser agora ou até 30 minutos atrás, se a reunião já começou.
        O closer não muda, mesmo que a agenda dele mostre ocupado.
      </p>
      <div className="group" style={{ flexWrap: "wrap" }}>
        <span className="lbl">Início</span>
        <input type="time" className="field" aria-label="Novo início hoje" value={hora}
          onChange={(e) => { setHora(e.target.value); setCheck(null); }} />
        <input type="number" className="field" style={{ width: 90 }} min={10} max={240} aria-label="Duração em minutos" value={duration}
          onChange={(e) => { setDuration(Number(e.target.value) || 30); setCheck(null); }} />
        <span className="muted">min</span>
        <button type="button" className="btn small" disabled={!local || pending}
          onClick={() => start(async () => setCheck(await conferirMesmoDia(id, local, duration)))}>
          {pending ? "Consultando a agenda…" : "Conferir agenda"}
        </button>
      </div>
      {check?.erro && <div className="alert" role="alert">{check.erro}</div>}
      {check && !check.erro && (
        <div role="status" className={check.situacao === "livre" ? "ok" : undefined}
          style={check.situacao === "livre" ? undefined : { border: "1px solid var(--stale)", color: "var(--stale)", borderRadius: "var(--radius-sm)", padding: "10px 12px" }}>
          {closerName}: {check.situacao}{check.situacao === "livre" ? "" : " (não impede salvar; confirme com o closer)"}
        </div>
      )}
      <form action={action} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="local" value={local} />
        <input type="hidden" name="duration" value={duration} />
        <textarea name="motivo" className="field" rows={2} maxLength={1000} required value={motivo} onChange={(e) => setMotivo(e.target.value)}
          aria-label="Motivo" placeholder="Motivo (ex.: o cliente pediu para antecipar e o closer confirmou)" />
        {state.erro && <div className="alert" role="alert">{state.erro}</div>}
        <div className="group">
          <span className="spacer" />
          <button type="submit" className="btn primary" disabled={!check || !!check.erro || !motivo.trim() || saving}>
            {saving ? "Salvando…" : "Mudar para hoje com o mesmo closer"}
          </button>
        </div>
      </form>
    </section>
  );
}
