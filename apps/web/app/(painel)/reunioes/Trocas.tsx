"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { closersLivres, decidirPedido, passarMarca, pedirTroca, trocarCloser } from "./actions";

function useAct() {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ erro?: string; ok?: string } | null>(null);
  const router = useRouter();
  const run = (fn: () => Promise<{ erro?: string }>, ok: string) => start(async () => {
    setMsg(null);
    const r = await fn();
    setMsg(r.erro ? { erro: r.erro } : { ok });
    router.refresh();
  });
  return { pending, msg, run };
}

const Msg = ({ msg }: { msg: { erro?: string; ok?: string } | null }) =>
  msg ? <span role={msg.erro ? "alert" : "status"} style={{ color: msg.erro ? "var(--danger, #e5484d)" : undefined }}>{msg.erro ?? msg.ok}</span> : null;

/** Ações de troca na linha da reunião: SDR pede troca; gestor troca direto; closer/gestor mudam a marca. */
export function RowTrocas({ id, status, futura, permissao, brand }: { id: string; status: string; futura: boolean; permissao: string; brand: string | null }) {
  const { pending, msg, run } = useAct();
  const [open, setOpen] = useState<"pedir" | "trocar" | null>(null);
  const [text, setText] = useState("");
  const [closers, setClosers] = useState<{ id: string; name: string }[] | null>(null);
  const [closer, setCloser] = useState("");
  const ativa = status === "agendada" && futura;
  return (
    <div className="cell-stack" style={{ gap: 4 }}>
      {permissao === "sdr" && ativa && <button type="button" className="btn small" onClick={() => setOpen(open === "pedir" ? null : "pedir")}>Pedir troca de closer</button>}
      {permissao === "gestor" && ativa && (
        <button type="button" className="btn small" onClick={() => {
          setOpen(open === "trocar" ? null : "trocar");
          if (open !== "trocar") { setClosers(null); closersLivres(id).then(setClosers); }
        }}>Trocar closer</button>
      )}
      {(permissao === "closer" || permissao === "gestor") && brand && (
        <button type="button" className="btn small" disabled={pending}
          onClick={() => { if (confirm(`Passar esta reunião para ${brand === "poli" ? "ChatsHub" : "Poli"}? Muda o carrossel e o título no painel e no Google.`)) run(() => passarMarca(id), "Marca trocada."); }}>
          Passar para {brand === "poli" ? "CH" : "Poli"}
        </button>
      )}
      {open === "pedir" && (
        <div className="cell-stack" style={{ gap: 4 }}>
          <textarea className="field" rows={2} maxLength={1000} placeholder="Justificativa (obrigatória)" value={text} onChange={(e) => setText(e.target.value)} aria-label="Justificativa do pedido" />
          <button type="button" className="btn small primary" disabled={!text.trim() || pending}
            onClick={() => run(async () => { const r = await pedirTroca(id, text); if (!r.erro) { setOpen(null); setText(""); } return r; }, "Pedido enviado ao gestor.")}>Enviar pedido</button>
        </div>
      )}
      {open === "trocar" && (
        <div className="cell-stack" style={{ gap: 4 }}>
          {closers === null ? <span className="muted">Consultando agendas…</span> : closers.length === 0 ? <span className="muted">Nenhum outro closer livre neste horário.</span> : (
            <>
              <select className="field" value={closer} onChange={(e) => setCloser(e.target.value)} aria-label="Novo closer">
                <option value="">Carrossel decide</option>
                {closers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <input className="field" placeholder="Motivo (obrigatório)" value={text} onChange={(e) => setText(e.target.value)} aria-label="Motivo da troca" />
              <button type="button" className="btn small primary" disabled={!text.trim() || pending}
                onClick={() => run(async () => { const r = await trocarCloser(id, closer || null, text); if (!r.erro) setOpen(null); return r; }, "Closer trocado.")}>Trocar</button>
            </>
          )}
        </div>
      )}
      <Msg msg={msg} />
    </div>
  );
}

export interface Pedido {
  id: string; meeting_id: string; status: string; reason: string; created_at: string; decision_note: string | null;
  sdr: string; lead_name: string | null; starts_at: string; closer_atual: string | null; de: string | null; para: string | null;
}

const when = (iso: string) => new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

/** Fila de pedidos pendentes (gestor e admin). */
export function FilaPedidos({ pedidos }: { pedidos: Pedido[] }) {
  return (
    <section className="card" style={{ gap: 10 }} aria-labelledby="fila">
      <h2 id="fila" className="card-title">Pedidos de troca de closer pendentes ({pedidos.length})</h2>
      {pedidos.map((p) => <PedidoItem key={p.id} p={p} />)}
    </section>
  );
}

function PedidoItem({ p }: { p: Pedido }) {
  const { pending, msg, run } = useAct();
  const [closers, setClosers] = useState<{ id: string; name: string }[] | null>(null);
  const [closer, setCloser] = useState("");
  const [nota, setNota] = useState("");
  return (
    <div className="cell-stack" style={{ gap: 6, borderTop: "1px solid var(--border, #333)", paddingTop: 8 }}>
      <span><strong>{p.sdr}</strong> pediu em {when(p.created_at)} · lead {p.lead_name ?? "—"} · reunião {when(p.starts_at)} · closer atual <strong>{p.closer_atual ?? "—"}</strong></span>
      <span className="muted">Justificativa: {p.reason}</span>
      <div className="group" style={{ flexWrap: "wrap" }}>
        <select className="field" value={closer} onFocus={() => { if (closers === null) closersLivres(p.meeting_id).then(setClosers); }}
          onChange={(e) => setCloser(e.target.value)} aria-label="Novo closer">
          <option value="">Carrossel decide</option>
          {(closers ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <input className="field" placeholder="Observação (opcional)" value={nota} onChange={(e) => setNota(e.target.value)} aria-label="Observação" />
        <button type="button" className="btn small primary" disabled={pending} onClick={() => run(() => decidirPedido(p.id, "aprovar", closer || null, nota), "Pedido aprovado.")}>Aprovar</button>
        <button type="button" className="btn small" disabled={pending} onClick={() => run(() => decidirPedido(p.id, "recusar", null, nota), "Pedido recusado.")}>Recusar</button>
        <Msg msg={msg} />
      </div>
    </div>
  );
}
