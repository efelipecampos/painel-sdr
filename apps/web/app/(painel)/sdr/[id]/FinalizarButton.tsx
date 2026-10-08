"use client";

// Finalizar à mão: para quando a nota "0" na Poli não chega ao painel (2026-10-08).
import { useState, useTransition } from "react";
import { finalizarLead } from "./actions";

export function FinalizarButton({ leadId, leadName, desfazer }: { leadId: string; leadName: string; desfazer?: boolean }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="cell-stack" style={{ alignItems: "flex-start" }}>
      <button type="button" disabled={pending}
        style={{ background: "none", border: "none", padding: 0, fontSize: 12, textDecoration: "underline", cursor: "pointer", color: "var(--text-muted)" }}
        aria-label={`${desfazer ? "Desfazer finalização de" : "Finalizar"} ${leadName}`}
        onClick={() => {
          if (!desfazer && !confirm(`Finalizar ${leadName}? Sai de "Aguardando" e de "Parados", como a nota "0" na Poli.`)) return;
          setError(null);
          start(async () => {
            const r = await finalizarLead(leadId, !desfazer);
            if (r.error) setError(r.error);
          });
        }}>
        {pending ? "Salvando..." : desfazer ? "Desfazer" : "Finalizar"}
      </button>
      {error && <span role="alert" className="muted" style={{ color: "var(--danger)" }}>{error}</span>}
    </span>
  );
}
