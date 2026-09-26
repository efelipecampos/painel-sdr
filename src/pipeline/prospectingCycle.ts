import { isProspectingOpener } from "../config/prospectingTemplates.js";
import type { MessageEvent } from "../poli/parser.js";

/**
 * Ciclo de prospecção: começa quando o time dispara um template de abertura
 * e fecha na primeira mensagem do lead depois disso. Um mesmo contato passa
 * por vários ciclos ao longo do tempo (ele se converte de novo, a cadência
 * recomeça), por isso o ciclo é sempre "o atual" — e só medimos o que a
 * integração viu inteiro, do disparo até a resposta.
 */

export const CYCLE_START_AT = "poli_prospeccao_iniciada_em";
export const CYCLE_TEMPLATE = "poli_template_da_prospeccao";
export const CYCLE_REPLIED_AT = "poli_primeira_resposta_em";
export const CYCLE_HOURS = "poli_tempo_ate_resposta_horas";

export const CYCLE_PROPERTIES = [CYCLE_START_AT, CYCLE_TEMPLATE, CYCLE_REPLIED_AT, CYCLE_HOURS];

export interface CurrentCycle {
  startedAtMs?: number;
  repliedAtMs?: number;
}

export interface CompletedCycle {
  startedAtMs: number;
  repliedAtMs: number;
  hours: number;
  templateName?: string;
}

export interface CyclePlan {
  /** Propriedades a gravar no contato (vazio = nada a fazer). */
  properties: Record<string, string>;
  /** Preenchido só quando esta mensagem fechou o ciclo. */
  completed?: CompletedCycle;
}

const EMPTY: CyclePlan = { properties: {} };

export function planCycleUpdate(current: CurrentCycle, message: MessageEvent): CyclePlan {
  if (message.direction === "OUT") {
    if (!message.isTemplate || !isProspectingOpener(message.templateName)) return EMPTY;
    // Novo ciclo: limpa a resposta do ciclo anterior pra não misturar.
    return {
      properties: {
        [CYCLE_START_AT]: String(message.timestampMs),
        [CYCLE_TEMPLATE]: message.templateName ?? "",
        [CYCLE_REPLIED_AT]: "",
        [CYCLE_HOURS]: "",
      },
    };
  }

  // Resposta do lead: só fecha ciclo aberto (disparo visto por nós) e ainda
  // sem resposta registrada. Mensagem anterior ao disparo não conta.
  if (current.startedAtMs === undefined || current.repliedAtMs !== undefined) return EMPTY;
  if (message.timestampMs < current.startedAtMs) return EMPTY;

  const hours = Math.round(((message.timestampMs - current.startedAtMs) / 3_600_000) * 100) / 100;
  return {
    properties: {
      [CYCLE_REPLIED_AT]: String(message.timestampMs),
      [CYCLE_HOURS]: String(hours),
    },
    completed: { startedAtMs: current.startedAtMs, repliedAtMs: message.timestampMs, hours },
  };
}
