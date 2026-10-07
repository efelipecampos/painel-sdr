"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { mudarStatus } from "./actions";

const OPCOES = [
  ["agendada", "Agendada"], ["validada", "Validada"], ["noshow", "No show"], ["invalidada", "Invalidada"], ["cancelada", "Cancelada"],
] as const;

// Closer da reunião, gestor e admin escolhem qualquer status; o SDR só confirma o cancelamento e muda o horário.
export function StatusActions({ id, status, permissao, aviso }: { id: string; status: string; permissao: string; aviso: string | null }) {
  const [pending, start] = useTransition();
  const [erro, setErro] = useState<string | null>(null);
  const router = useRouter();
  const set = (s: string) => start(async () => {
    setErro(null);
    const r = await mudarStatus(id, s);
    if (r.erro) setErro(r.erro);
    router.refresh();
  });
  const podeHorario = (permissao === "sdr" || permissao === "gestor") && status !== "validada" && status !== "invalidada";
  return (
    <div className="cell-stack" style={{ gap: 4 }}>
      {permissao === "sdr" ? (
        status !== "cancelada" && (
          <button type="button" className="btn small" disabled={pending}
            onClick={() => { if (confirm("Confirmar que esta reunião foi cancelada? O evento sai da agenda do closer.")) set("cancelada"); }}>
            {aviso === "recusada_lead" ? "Confirmar cancelamento" : "Cancelar"}
          </button>
        )
      ) : (
        <select className="field" value={status} disabled={pending} aria-label="Situação da reunião" onChange={(e) => set(e.target.value)}>
          {OPCOES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      )}
      {podeHorario && <Link href={`/reunioes/${id}/horario`} className="btn small">{status === "cancelada" ? "Reagendar" : "Mudar horário"}</Link>}
      {erro && <span role="alert" style={{ color: "var(--danger, #e5484d)" }}>{erro}</span>}
    </div>
  );
}
