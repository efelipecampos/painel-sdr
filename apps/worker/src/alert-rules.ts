// Regras dos alertas de operação (Fase 8), sem banco nem rede, para poder testar.
// LGPD: os textos nunca levam conteúdo de mensagem, nome ou telefone de lead.

export type AlertKey = "fila" | "poli" | "worker" | "hubspot" | "painel" | "score";

/** Mudança de estado de um alerta: "problema" ao passar do limite, "resolvido" quando volta ao normal depois de avisar. */
export type Transition = { key: AlertKey; kind: "problema" | "resolvido"; minutos: number };

/**
 * Guarda desde quando cada verificação está falhando e decide quando avisar.
 * Puro (o relógio vem de fora) para poder ser testado.
 */
export class AlertState {
  private failingSince = new Map<AlertKey, number>();
  private alerted = new Set<AlertKey>();

  /** ok=false marca falha; avisa quando a falha dura `limiteMin` minutos ou mais. */
  report(key: AlertKey, ok: boolean, now: number, limiteMin: number): Transition | null {
    if (ok) {
      const since = this.failingSince.get(key);
      this.failingSince.delete(key);
      if (!this.alerted.delete(key) || since === undefined) return null;
      return { key, kind: "resolvido", minutos: Math.round((now - since) / 60_000) };
    }
    const since = this.failingSince.get(key) ?? now;
    this.failingSince.set(key, since);
    const minutos = (now - since) / 60_000;
    if (this.alerted.has(key) || minutos < limiteMin) return null;
    this.alerted.add(key);
    return { key, kind: "problema", minutos: Math.round(minutos) };
  }
}

/** Fila parada: há evento esperando e o mais antigo chegou há `limiteMin` minutos ou mais. */
export function filaParada(oldestPendingAt: Date | null, now: Date, limiteMin: number): boolean {
  return !!oldestPendingAt && now.getTime() - oldestPendingAt.getTime() >= limiteMin * 60_000;
}

/** Integração muda: o tempo em horário comercial desde o último evento da Poli passou do limite. */
export function poliMuda(businessSecondsSinceLast: number | null, limiteMin: number): boolean {
  return businessSecondsSinceLast !== null && businessSecondsSinceLast >= limiteMin * 60;
}

/** Texto do alerta. `detalhe` complementa o problema (sem dados pessoais). */
export function alertText(t: Transition, detalhe = ""): string {
  if (t.kind === "resolvido") {
    const ok: Record<AlertKey, string> = {
      fila: "a fila de eventos voltou a andar",
      poli: "eventos da Poli voltaram a chegar",
      worker: "o worker voltou a funcionar",
      hubspot: "a sincronização com o HubSpot voltou a funcionar",
      painel: "o painel voltou a responder",
      score: "o score de qualidade voltou a funcionar",
    };
    return `✅ *Painel SDR:* ${ok[t.key]} (problema durou ${t.minutos} min).`;
  }
  const problema: Record<AlertKey, string> = {
    fila: "fila de eventos parada. O worker não está processando o que chega da Poli; os números do painel estão atrasados.",
    poli: `nenhum evento da Poli há ${t.minutos} min em horário comercial. Confira a integração poli-hubspot.`,
    worker: `o worker está com erro há ${t.minutos} min.`,
    hubspot: `a sincronização com o HubSpot está falhando há ${t.minutos} min.`,
    painel: `o painel não responde há ${t.minutos} min.`,
    score: `o score de qualidade está falhando há ${t.minutos} min.`,
  };
  return [`🔴 *Painel SDR:* ${problema[t.key]}`, detalhe].filter(Boolean).join("\n");
}
