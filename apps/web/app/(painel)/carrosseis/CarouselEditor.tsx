"use client";

import { useState } from "react";
import { archiveCarousel, saveCarousel } from "./actions";

export interface CarouselRow {
  id: string; brand: "poli" | "chatshub"; name: string; description: string | null; active: boolean;
  balance_period: "month" | "week"; refund_noshow: boolean; refund_cancelada: boolean; refund_invalidada: boolean;
  min_notice_minutes: number; window_business_days: number; gap_minutes: number; durations: number[]; sticky_days: number;
}
export interface MemberRow {
  closer_id: string; name: string; weight: number; active: boolean; fatia: number | null;
  recebidas: number; esperado: number; saldo: number;
}

export function CarouselEditor({ carousel, members, closers, periodLabel }: {
  carousel: CarouselRow; members: MemberRow[]; closers: { id: string; name: string }[]; periodLabel: string;
}) {
  const [rows, setRows] = useState(members.map((m) => ({ closer_id: m.closer_id, name: m.name, weight: m.weight, active: m.active })));
  const [add, setAdd] = useState("");
  const stats = new Map(members.map((m) => [m.closer_id, m]));
  const totalWeight = rows.filter((r) => r.active && r.weight > 0).reduce((a, r) => a + r.weight, 0);
  const available = closers.filter((c) => !rows.some((r) => r.closer_id === c.id));
  const set = (id: string, patch: Partial<{ weight: number; active: boolean }>) =>
    setRows(rows.map((r) => (r.closer_id === id ? { ...r, ...patch } : r)));

  return (
    <form action={saveCarousel} className="card" style={{ gap: 16 }}>
      <input type="hidden" name="id" value={carousel.id} />
      <input type="hidden" name="members" value={JSON.stringify(rows.map(({ closer_id, weight, active }) => ({ closer_id, weight, active })))} />

      <section className="cell-stack" style={{ gap: 8 }} aria-labelledby="ident">
        <h2 id="ident" className="card-title">Identificação do carrossel</h2>
        <label className="lbl" htmlFor="name">Nome</label>
        <input id="name" name="name" className="field" defaultValue={carousel.name} required />
        <label className="lbl" htmlFor="description">Quando o SDR deve escolher este carrossel</label>
        <textarea id="description" name="description" className="field" rows={2} defaultValue={carousel.description ?? ""} />
        <div className="group">
          <label className="lbl" htmlFor="brand">Empresa</label>
          <select id="brand" name="brand" className="field" defaultValue={carousel.brand}>
            <option value="poli">Poli</option>
            <option value="chatshub">ChatsHub</option>
          </select>
          <span className="spacer" />
          <button type="submit" formAction={archiveCarousel} name="active" value={carousel.active ? "false" : "true"} className="btn small">
            {carousel.active ? "Arquivar" : "Reativar"}
          </button>
        </div>
      </section>

      <section className="cell-stack" style={{ gap: 8 }} aria-labelledby="closers">
        <h2 id="closers" className="card-title">Closers e pesos · {periodLabel}</h2>
        <p className="muted" style={{ margin: 0 }}>Peso 2 recebe o dobro de peso 1. A reunião vai para o closer livre no horário que está mais atrás da fatia dele.</p>
        <div className="table-wrap">
          <table>
            <thead><tr>
              <th scope="col">Closer</th><th scope="col">No carrossel</th><th scope="col">Peso</th>
              <th scope="col">Fatia</th><th scope="col">Recebidas</th><th scope="col">Esperado</th>
              <th scope="col"><span className="sr-only">Remover</span></th>
            </tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={7} className="muted">Nenhum closer neste carrossel.</td></tr>}
              {rows.map((r) => {
                const st = stats.get(r.closer_id);
                const fatia = r.active && r.weight > 0 && totalWeight > 0 ? r.weight / totalWeight : null;
                return (
                  <tr key={r.closer_id}>
                    <td>{r.name}</td>
                    <td><input type="checkbox" checked={r.active} onChange={(e) => set(r.closer_id, { active: e.target.checked })} aria-label={`${r.name} no carrossel`} /></td>
                    <td>
                      <div className="group">
                        <button type="button" className="btn small" onClick={() => set(r.closer_id, { weight: Math.max(0, r.weight - 1) })} aria-label={`Diminuir peso de ${r.name}`}>−</button>
                        <span style={{ minWidth: 20, textAlign: "center" }}>{r.weight}</span>
                        <button type="button" className="btn small" onClick={() => set(r.closer_id, { weight: Math.min(100, r.weight + 1) })} aria-label={`Aumentar peso de ${r.name}`}>+</button>
                      </div>
                    </td>
                    <td>{fatia == null ? "—" : `${Math.round(fatia * 100)}%`}</td>
                    <td>{st ? Number(st.recebidas) : 0}</td>
                    <td>{st ? Number(st.esperado).toFixed(1) : "0.0"}</td>
                    <td>
                      <button type="button" className="btn small" aria-label={`Remover ${r.name} do carrossel`}
                        onClick={() => setRows(rows.filter((x) => x.closer_id !== r.closer_id))}>Remover</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="group">
          <select className="field" value={add} onChange={(e) => setAdd(e.target.value)} aria-label="Adicionar closer">
            <option value="">Adicionar closer…</option>
            {available.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <button type="button" className="btn small" disabled={!add} onClick={() => {
            const c = closers.find((x) => x.id === add);
            if (c) setRows([...rows, { closer_id: c.id, name: c.name, weight: 1, active: true }]);
            setAdd("");
          }}>Adicionar</button>
        </div>
        <p className="muted" style={{ margin: 0 }}>Remover tira o closer deste carrossel ao salvar. As reuniões que ele já recebeu continuam guardadas.</p>
      </section>

      <section className="cell-stack" style={{ gap: 8 }} aria-labelledby="regras">
        <h2 id="regras" className="card-title">Regras deste carrossel</h2>
        <div className="group">
          <label className="lbl" htmlFor="balance_period">Equilibrar por</label>
          <select id="balance_period" name="balance_period" className="field" defaultValue={carousel.balance_period}>
            <option value="month">Mês</option>
            <option value="week">Semana</option>
          </select>
        </div>
        <span className="lbl">Reunião que não aconteceu devolve a vez ao closer</span>
        <div className="group">
          <label className="switch"><input type="checkbox" name="refund_noshow" defaultChecked={carousel.refund_noshow} /> No show</label>
          <label className="switch"><input type="checkbox" name="refund_cancelada" defaultChecked={carousel.refund_cancelada} /> Cancelada</label>
          <label className="switch"><input type="checkbox" name="refund_invalidada" defaultChecked={carousel.refund_invalidada} /> Invalidada</label>
        </div>
        <div className="group">
          <label className="lbl" htmlFor="sticky_days">Lead mantém o mesmo closer por</label>
          <input id="sticky_days" name="sticky_days" type="number" min={0} max={365} className="field" style={{ width: 80 }} defaultValue={carousel.sticky_days} />
          <span className="muted">dias</span>
        </div>
        <div className="group">
          <label className="lbl" htmlFor="min_notice">Antecedência mínima</label>
          <input id="min_notice" name="min_notice_hours" type="number" min={0} max={72} step="0.5" className="field" style={{ width: 80 }} defaultValue={carousel.min_notice_minutes / 60} />
          <span className="muted">horas</span>
          <label className="lbl" htmlFor="window">Janela</label>
          <input id="window" name="window_business_days" type="number" min={1} max={60} className="field" style={{ width: 80 }} defaultValue={carousel.window_business_days} />
          <span className="muted">dias úteis</span>
          <label className="lbl" htmlFor="gap">Intervalo entre reuniões</label>
          <input id="gap" name="gap_minutes" type="number" min={0} max={120} className="field" style={{ width: 80 }} defaultValue={carousel.gap_minutes} />
          <span className="muted">min</span>
        </div>
        <div className="group">
          <label className="lbl" htmlFor="durations">Durações oferecidas (min, separadas por vírgula)</label>
          <input id="durations" name="durations" className="field" style={{ width: 160 }} defaultValue={carousel.durations.join(", ")} />
        </div>
        <p className="muted" style={{ margin: 0 }}>
          O SDR nunca escolhe nem vê o closer antes de confirmar. Reagendar tenta o mesmo closer; se ele não estiver livre, o carrossel escolhe outro.
        </p>
      </section>

      <div className="group">
        <span className="spacer" />
        <button type="submit" className="btn primary">Salvar</button>
      </div>
    </form>
  );
}
