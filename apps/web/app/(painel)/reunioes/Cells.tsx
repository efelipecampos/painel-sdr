"use client";

// Células da tabela de Reuniões e fila de pedidos (design/Reunioes.dc.html).
import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { closersLivres, decidirPedido, mudarStatus, passarMarca, pedirTroca, recriarEvento, trocarCloser } from "./actions";

type Msg = { erro?: string; ok?: string } | null;

function useAct() {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<Msg>(null);
  const router = useRouter();
  const run = (fn: () => Promise<{ erro?: string }>, ok: string) => start(async () => {
    setMsg(null);
    const r = await fn();
    setMsg(r.erro ? { erro: r.erro } : { ok });
    router.refresh();
  });
  return { pending, msg, run };
}

const Feedback = ({ msg }: { msg: Msg }) =>
  msg ? <span role={msg.erro ? "alert" : "status"} className="ag-hint" style={{ color: msg.erro ? "var(--danger)" : "#7fd6a6" }}>{msg.erro ?? msg.ok}</span> : null;

const OPCOES = [["agendada", "Agendada"], ["validada", "Validada"], ["invalidada", "Invalidada"], ["noshow", "No show"], ["cancelada", "Cancelada"]] as const;
const LABEL: Record<string, string> = Object.fromEntries(OPCOES);
const PROBLEMA: Record<string, string> = {
  removida: "Evento apagado da agenda do closer", recusada_lead: "Lead recusou o convite no Google", recusada_closer: "Closer recusou o convite no Google",
};

/** Situação: closer, gestor e admin escolhem; o SDR só cancela. Com problema no Google: aviso e ações. */
export function StatusCell({ id, status, permissao, problema, company }: { id: string; status: string; permissao: string; problema: string | null; company: string }) {
  const { pending, msg, run } = useAct();
  if (problema) {
    return (
      <div className="cell-stack" style={{ gap: 6, alignItems: "flex-start" }}>
        <span className="ag-pill" style={{ marginRight: 0 }}>{PROBLEMA[problema] ?? "Mudou no Google"}</span>
        <div style={{ display: "flex", gap: 8 }}>
          {problema !== "recusada_lead" && (
            <button type="button" className="rn-mini" disabled={pending} onClick={() => run(() => recriarEvento(id), "Evento recriado.")}>Recriar evento</button>
          )}
          <button type="button" className="rn-mini ghost" disabled={pending}
            onClick={() => { if (confirm(`Marcar a reunião com ${company} como cancelada?`)) run(() => mudarStatus(id, "cancelada"), "Marcada como cancelada."); }}>
            Marcar como cancelada
          </button>
        </div>
        <Feedback msg={msg} />
      </div>
    );
  }
  if (permissao === "sdr") {
    return (
      <div className="cell-stack" style={{ gap: 4, alignItems: "flex-start" }}>
        <span style={{ fontWeight: status === "agendada" ? 400 : 600 }}>{LABEL[status] ?? status}</span>
        {status === "agendada" && (
          <button type="button" className="rn-mini ghost" disabled={pending}
            onClick={() => { if (confirm(`Confirmar que a reunião com ${company} foi cancelada? O evento sai da agenda do closer.`)) run(() => mudarStatus(id, "cancelada"), "Cancelada."); }}>
            Cancelar
          </button>
        )}
        <Feedback msg={msg} />
      </div>
    );
  }
  return (
    <div className="cell-stack" style={{ gap: 4 }}>
      <select className={`rn-status${status !== "agendada" ? " set" : ""}`} value={status} disabled={pending} aria-label={`Situação da reunião com ${company}`}
        onChange={(e) => run(() => mudarStatus(id, e.target.value), "Situação salva.")}>
        {OPCOES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
      <Feedback msg={msg} />
    </div>
  );
}

/** Ações: Reagendar, Trocar closer (gestor) ou Pedir troca (SDR), Passar para CH/Poli, Abrir Meet. */
export function ActionsCell({ id, status, futura, permissao, brand, meetUrl, pedidoPendente, company }: {
  id: string; status: string; futura: boolean; permissao: string; brand: string | null; meetUrl: string | null; pedidoPendente: boolean; company: string;
}) {
  const { pending, msg, run } = useAct();
  const [open, setOpen] = useState<"pedir" | "trocar" | null>(null);
  const [text, setText] = useState("");
  const [closers, setClosers] = useState<{ id: string; name: string }[] | null>(null);
  const [closer, setCloser] = useState("");
  const ativa = status === "agendada" && futura;
  const podeHorario = (permissao === "sdr" || permissao === "gestor") && (status === "agendada" || status === "cancelada");
  return (
    <div className="cell-stack" style={{ alignItems: "flex-end" }}>
      <div className="rn-actions">
        {podeHorario && <Link href={`/reunioes/${id}/horario`} aria-label={`Reagendar reunião com ${company}`}>Reagendar</Link>}
        {permissao === "gestor" && ativa && (
          <button type="button" className="link" aria-label={`Trocar o closer da reunião com ${company}`}
            onClick={() => { const o = open === "trocar" ? null : "trocar"; setOpen(o); if (o) { setClosers(null); closersLivres(id).then(setClosers); } }}>Trocar closer</button>
        )}
        {permissao === "sdr" && ativa && !pedidoPendente && (
          <button type="button" className="link" onClick={() => setOpen(open === "pedir" ? null : "pedir")}>Pedir troca de closer</button>
        )}
        {(permissao === "closer" || permissao === "gestor") && brand && status !== "cancelada" && (
          <button type="button" className="link" disabled={pending}
            onClick={() => { if (confirm(`Passar a reunião com ${company} para ${brand === "poli" ? "ChatsHub" : "Poli"}? Muda o carrossel e o título no painel e no Google.`)) run(() => passarMarca(id), "Marca trocada."); }}>
            Passar para {brand === "poli" ? "CH" : "Poli"}
          </button>
        )}
        {meetUrl && status === "agendada" && <a href={meetUrl} target="_blank" rel="noreferrer" aria-label={`Abrir o Meet da reunião com ${company}`}>Abrir Meet</a>}
      </div>
      {open === "pedir" && (
        <div className="rn-pop">
          <label className="ag-label" htmlFor={`sw-${id}`}>Por que precisa de outro closer? Você não escolhe o novo closer.</label>
          <input id={`sw-${id}`} className="field" value={text} maxLength={1000} onChange={(e) => setText(e.target.value)} placeholder="Justificativa (obrigatória)" />
          <button type="button" className="rn-mini" disabled={!text.trim() || pending}
            onClick={() => run(async () => { const r = await pedirTroca(id, text); if (!r.erro) { setOpen(null); setText(""); } return r; }, "Pedido enviado ao gestor.")}>Enviar pedido</button>
        </div>
      )}
      {open === "trocar" && (
        <div className="rn-pop">
          {closers === null ? <span className="ag-hint">Consultando agendas…</span> : closers.length === 0 ? <span className="ag-hint">Nenhum outro closer livre neste horário.</span> : (
            <>
              <select className="field" value={closer} onChange={(e) => setCloser(e.target.value)} aria-label="Novo closer">
                <option value="">Carrossel escolhe</option>
                {closers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <input className="field" placeholder="Motivo (obrigatório)" value={text} onChange={(e) => setText(e.target.value)} aria-label="Motivo da troca" />
              <button type="button" className="rn-mini" disabled={!text.trim() || pending}
                onClick={() => run(async () => { const r = await trocarCloser(id, closer || null, text); if (!r.erro) setOpen(null); return r; }, "Closer trocado.")}>Trocar</button>
            </>
          )}
        </div>
      )}
      <Feedback msg={msg} />
    </div>
  );
}

export interface Pedido {
  id: string; meeting_id: string; status: string; reason: string; created_at: string; decision_note: string | null;
  sdr: string; lead_name: string | null; starts_at: string; closer_atual: string | null; de: string | null; para: string | null;
}

function ago(iso: string): string {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (m < 60) return `Pediu há ${m} min`;
  const h = Math.floor(m / 60);
  return h < 24 ? `Pediu há ${h}h ${String(m % 60).padStart(2, "0")}min` : `Pediu há ${Math.floor(h / 24)} dia(s)`;
}

/** Linha da fila de pedidos de troca (gestor e admin). */
export function RequestRow({ p }: { p: Pedido }) {
  const { pending, msg, run } = useAct();
  const [closers, setClosers] = useState<{ id: string; name: string }[] | null>(null);
  const [closer, setCloser] = useState("");
  const when = new Date(p.starts_at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  return (
    <div className="rn-req-row">
      <div className="rn-stack"><span style={{ fontWeight: 600 }}>{p.sdr}</span><span className="ag-hint">{ago(p.created_at)}</span></div>
      <div className="rn-stack"><span style={{ fontWeight: 600 }}>{p.lead_name ?? "—"}</span><span className="ag-hint">{when}</span></div>
      <div className="rn-stack"><span className="ag-hint">Closer atual</span><span>{p.closer_atual ?? "—"}</span></div>
      <div className="rn-stack"><span className="ag-hint">Justificativa do SDR</span><span>{p.reason}</span></div>
      <div className="rn-stack" style={{ gap: 4 }}>
        <label htmlFor={`req-${p.id}`} className="ag-hint">Novo closer</label>
        <select id={`req-${p.id}`} className="field" style={{ height: 36 }} value={closer}
          onFocus={() => { if (closers === null) closersLivres(p.meeting_id).then(setClosers); }} onChange={(e) => setCloser(e.target.value)}>
          <option value="">Carrossel escolhe</option>
          {(closers ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
      <button type="button" className="btn primary" style={{ height: 36, fontWeight: 600 }} disabled={pending}
        onClick={() => run(() => decidirPedido(p.id, "aprovar", closer || null, ""), "Pedido aprovado.")}>Aprovar</button>
      <button type="button" className="btn" style={{ height: 36 }} disabled={pending}
        onClick={() => { const nota = prompt("Motivo da recusa (opcional):") ?? ""; run(() => decidirPedido(p.id, "recusar", null, nota), "Pedido recusado."); }}>Recusar</button>
      {msg && <div style={{ gridColumn: "1 / -1" }}><Feedback msg={msg} /></div>}
    </div>
  );
}
