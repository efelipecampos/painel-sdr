import type { Carteira, LeadNota } from "@/lib/data";
import { Metric } from "./Metric";

/** "Qualidade da carteira" para o card do time e dos SDRs. */
export function QualidadeCarteira({ c }: { c: Carteira | undefined }) {
  if (!c || c.carteira === 0) return <Metric label="Qualidade da carteira" value="—" sub="carteira vazia" />;
  return (
    <Metric
      label="Qualidade da carteira"
      value={c.qualidade == null ? "—" : <>{c.qualidade}<small>/100</small></>}
      sub={`${c.avaliados} avaliados · ${c.sem_avaliacao} sem avaliação`}
    />
  );
}

const SEM_NOTA: Record<Exclude<LeadNota["status"], "avaliado">, string> = {
  abaixo_do_corte: "Poucas mensagens",
  sem_informacao: "Sem informação",
  ja_e_cliente: "Já é cliente",
};

/** Nota do lead na tabela de chats; abre a justificativa por critério. */
export function NotaLead({ n }: { n: LeadNota | undefined }) {
  if (!n) return <span className="muted">Não analisado</span>;
  if (n.status !== "avaliado") return <span className="muted">{SEM_NOTA[n.status]}</span>;
  return (
    <details>
      <summary aria-label={`Nota ${n.score} de 100: ver justificativa`}>{n.score}</summary>
      <div className="cell-stack" style={{ maxWidth: 360, whiteSpace: "normal" }}>
        {n.summary && <span>{n.summary}</span>}
        {n.criteria_scores.map((c, i) => (
          <span key={i} className="muted">
            <strong>{c.criterio ?? "Critério removido"}: {c.nota ?? "sem informação"}</strong> — {c.justificativa}
          </span>
        ))}
      </div>
    </details>
  );
}
