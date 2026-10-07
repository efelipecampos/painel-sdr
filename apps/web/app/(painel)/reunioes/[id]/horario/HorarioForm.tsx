"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import { conferirReagendar, diasReagendar, horariosReagendar, reagendar } from "../../actions";

const fmtDay = (d: string) => {
  const dt = new Date(`${d}T12:00:00Z`);
  return `${dt.toLocaleDateString("pt-BR", { weekday: "short", timeZone: "UTC" }).replace(".", "")} ${d.slice(8, 10)}/${d.slice(5, 7)}`;
};
const closers = (n: number) => (n === 1 ? "1 closer disponível" : `${n} closers disponíveis`);

export function HorarioForm({ id, initialDuration }: { id: string; initialDuration: number }) {
  const [pending, start] = useTransition();
  const [days, setDays] = useState<string[]>([]);
  const [day, setDay] = useState("");
  const [duration, setDuration] = useState(initialDuration);
  const [slots, setSlots] = useState<{ start: string; count: number }[] | null>(null);
  const [local, setLocal] = useState("");
  const [check, setCheck] = useState<{ erro: string | null; avisos: string[]; count: number } | null>(null);
  const [state, action, saving] = useActionState(reagendar, {});

  useEffect(() => { diasReagendar(id).then(setDays).catch(() => setDays([])); }, [id]);

  const load = (d: string, dur: number) => start(async () => {
    setSlots(null);
    setSlots(await horariosReagendar(id, d, dur));
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <section className="card" style={{ gap: 10 }}>
        <div className="group" style={{ flexWrap: "wrap", gap: 6 }}>
          {days.map((d) => (
            <button key={d} type="button" className={`btn small${day === d ? " primary" : ""}`} aria-pressed={day === d}
              onClick={() => { setDay(d); setLocal(""); setCheck(null); load(d, duration); }}>{fmtDay(d)}</button>
          ))}
        </div>
        {pending && <span className="muted">Consultando as agendas…</span>}
        {slots && slots.length === 0 && <span className="muted">Nenhum horário neste dia.</span>}
        {slots && slots.length > 0 && (
          <div className="group" style={{ flexWrap: "wrap", gap: 6 }}>
            {slots.map((s) => {
              const l = `${day}T${s.start}`;
              return (
                <button key={s.start} type="button" disabled={s.count === 0} className={`btn small${local === l ? " primary" : ""}`} aria-pressed={local === l}
                  onClick={() => { setLocal(l); setCheck({ erro: null, avisos: [], count: s.count }); }}>
                  {s.start} · {s.count === 0 ? "sem closer" : closers(s.count)}
                </button>
              );
            })}
          </div>
        )}
        {day && (
          <div className="group">
            <span className="lbl">Ajustar horário</span>
            <input type="time" className="field" aria-label="Início" value={local.slice(11)}
              onChange={(e) => { if (e.target.value) { setLocal(`${day}T${e.target.value}`); setCheck(null); } }} />
            <input type="number" className="field" style={{ width: 90 }} min={10} max={240} aria-label="Duração em minutos" value={duration}
              onChange={(e) => { const d = Number(e.target.value) || 30; setDuration(d); setCheck(null); load(day, d); }} />
            <span className="muted">min</span>
            <button type="button" className="btn small" disabled={!local || pending}
              onClick={() => start(async () => { const r = await conferirReagendar(id, local, duration); setCheck({ erro: r.erro, avisos: r.avisos, count: r.count }); })}>
              Conferir agenda
            </button>
          </div>
        )}
        {check?.erro && <div className="alert" role="alert">{check.erro}</div>}
        {check && !check.erro && (
          <div role="status" className={check.count > 0 ? "ok" : "alert"}>
            {local.slice(8, 10)}/{local.slice(5, 7)} às {local.slice(11)} · {duration} min · {check.count > 0 ? closers(check.count) : "nenhum closer livre neste horário"}
            {check.avisos.length > 0 && <> · Fora do horário padrão: {check.avisos.join("; ")}</>}
          </div>
        )}
      </section>
      <form action={action} className="group">
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="local" value={local} />
        <input type="hidden" name="duration" value={duration} />
        {state.erro && <div className="alert" role="alert" style={{ flex: 1 }}>{state.erro}</div>}
        <span className="spacer" />
        <button type="submit" className="btn primary" disabled={!local || !check || !!check.erro || check.count === 0 || saving}>
          {saving ? "Salvando…" : "Confirmar novo horário"}
        </button>
      </form>
    </div>
  );
}
