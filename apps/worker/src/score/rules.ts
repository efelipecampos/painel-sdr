// Score de qualidade (Fase 7): montagem do pedido ao modelo e cálculo da nota. Sem banco nem rede, para testar.
// LGPD: telefone e e-mail são mascarados antes de qualquer texto sair para a API; nada disto vai para log.
import { createHash } from "node:crypto";

export interface Criterion {
  id: string;          // painel.quality_criteria.id (ou a chave do critério inicial, no modo teste)
  name: string;
  description: string;
  weight: number;
}

export interface TranscriptMessage {
  sender: "lead" | "sdr" | "bot" | "template" | "system";
  body: string | null;
  template_name: string | null;
  sent_at: string;
}

/** Critérios iniciais (aprovados pelo Felipe em 07/10/2026, para ajustar depois na tela). */
export const DEFAULT_CRITERIA: Criterion[] = [
  { id: "engajamento", name: "Engajamento", weight: 3,
    description: "Conversa de verdade: várias mensagens, áudios, responde às perguntas do SDR. Nota baixa para 1 ou 2 mensagens curtas, silêncio depois do primeiro contato ou resposta automática do WhatsApp Business." },
  { id: "porte", name: "Porte", weight: 3,
    description: "Equipe de 3 ou mais pessoas atendendo clientes, setores, diretoria, fluxo de atendimento, CNPJ. Nota baixa para autônomo, \"atendo sozinho\" ou menos de 3 usuários. Sem informação sobre porte: nota intermediária." },
  { id: "dor", name: "Dor de atendimento", weight: 2,
    description: "Descreve um problema de atendimento que a Poli resolve: desorganização, demora para responder, conversas perdidas, falta de controle sobre o time, vários números." },
  { id: "intencao", name: "Intenção de avançar", weight: 2,
    description: "Pede reunião, proposta ou preço, aceita agendar. Nota baixa quando pede para encerrar, diz que não pediu contato ou some." },
  { id: "encaixe", name: "Encaixe no produto", weight: 2,
    description: "Quer atendimento com vários atendentes pelo WhatsApp. Nota baixa quando procura só disparo em massa, catálogo ou divulgação." },
];

/** Contexto da Poli (rascunho aprovado pelo Felipe em 07/10/2026). */
export const DEFAULT_CONTEXT =
  "A Poli Digital vende uma plataforma de atendimento pelo WhatsApp para empresas: vários atendentes no mesmo número, " +
  "distribuição de conversas entre setores, chatbot e integração com CRM. O cliente ideal é uma empresa com 3 ou mais " +
  "pessoas atendendo clientes pelo WhatsApp, que hoje sofre com desorganização, demora para responder, perda de conversas " +
  "ou falta de controle sobre o time. A Poli não vende para quem tem menos de 3 usuários nem para autônomos. Ela também " +
  "não é ferramenta de disparo em massa, catálogo ou divulgação. O objetivo do SDR é qualificar o lead e marcar uma " +
  "reunião com o closer.";

/** Troca e-mails e números de telefone por marcadores. */
export function maskPII(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[e-mail]")
    .replace(/(?:\+|\()?\d[\d\s().-]{6,}\d/g, (m) => (m.replace(/\D/g, "").length >= 8 ? "[telefone]" : m));
}

const WHO: Record<TranscriptMessage["sender"], string> = {
  lead: "Lead", sdr: "SDR", bot: "Robô", template: "Template", system: "Sistema",
};

function hhmm(iso: string): string {
  return new Date(iso).toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

/**
 * Conversa em texto, da mais antiga para a mais recente, com as últimas `maxMessages` mensagens
 * e no máximo `maxChars` caracteres (corta as mais antigas). Eventos do sistema ficam de fora.
 */
export function buildTranscript(msgs: TranscriptMessage[], maxMessages = 80, maxChars = 12_000): string {
  const lines = msgs
    .filter((m) => m.sender !== "system")
    .map((m) => {
      const body = m.body?.trim() ? maskPII(m.body.trim()) : m.template_name ? `(modelo "${m.template_name}")` : "(mídia ou mensagem sem texto)";
      return `[${hhmm(m.sent_at)}] ${WHO[m.sender]}: ${body}`;
    })
    .slice(-maxMessages);
  const out: string[] = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    size += lines[i].length + 1;
    if (size > maxChars && out.length) break;
    out.unshift(lines[i].length > maxChars ? lines[i].slice(0, maxChars) + "…" : lines[i]);
  }
  if (out.length < msgs.filter((m) => m.sender !== "system").length) out.unshift("(mensagens anteriores omitidas)");
  return out.join("\n");
}

/** Chave curta de cada critério no pedido ao modelo (c1, c2, ...), na ordem recebida. */
export function criterionKeys(criteria: Criterion[]): string[] {
  return criteria.map((_, i) => `c${i + 1}`);
}

/** Parte fixa do pedido: igual para todos os leads, para aproveitar o cache. */
export function systemPrompt(context: string, criteria: Criterion[]): string {
  const keys = criterionKeys(criteria);
  return [
    "Você avalia a qualidade de leads de vendas B2B a partir da conversa de WhatsApp entre o lead e o SDR.",
    "",
    "## Sobre a empresa",
    context,
    "",
    "## Critérios",
    "Dê a cada critério uma nota de 0 a 100 (0 = muito ruim, 50 = sem informação suficiente, 100 = excelente).",
    ...criteria.map((c, i) => `- ${keys[i]} — ${c.name}: ${c.description}`),
    "",
    "## Regras",
    "- Avalie o lead, não o SDR. Mensagens do SDR, do robô e de modelos só dão contexto.",
    "- Use apenas o que está na conversa. Não suponha o que não foi dito.",
    "- Justificativa: uma frase curta em português, citando o fato da conversa que levou à nota.",
    "- Nunca escreva nome de pessoa, telefone ou e-mail na justificativa nem no resumo.",
    "- Resumo: uma frase sobre o lead como um todo.",
  ].join("\n");
}

/** Formato da resposta (structured outputs). */
export function outputSchema(criteria: Criterion[]): { [key: string]: unknown } {
  return {
    type: "object",
    additionalProperties: false,
    required: ["criterios", "resumo"],
    properties: {
      criterios: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["criterio", "nota", "justificativa"],
          properties: {
            criterio: { type: "string", enum: criterionKeys(criteria) },
            nota: { type: "integer" },
            justificativa: { type: "string" },
          },
        },
      },
      resumo: { type: "string" },
    },
  };
}

export interface ModelAnswer {
  criterios: { criterio: string; nota: number; justificativa: string }[];
  resumo: string;
}

export interface CriterionScore { criterion_id: string; score: number; justificativa: string }

/**
 * Converte a resposta do modelo na nota de cada critério e na nota final (média ponderada, 0 a 100).
 * Falha se faltar critério: melhor não gravar do que gravar nota parcial.
 */
export function scoreFromAnswer(criteria: Criterion[], answer: ModelAnswer): { score: number; criteria_scores: CriterionScore[] } {
  const keys = criterionKeys(criteria);
  const byKey = new Map(answer.criterios.map((c) => [c.criterio, c]));
  const criteria_scores = criteria.map((c, i) => {
    const a = byKey.get(keys[i]);
    if (!a) throw new Error(`resposta sem o critério ${c.name}`);
    return { criterion_id: c.id, score: Math.max(0, Math.min(100, Math.round(a.nota))), justificativa: a.justificativa };
  });
  const totalWeight = criteria.reduce((s, c) => s + c.weight, 0);
  if (totalWeight <= 0) throw new Error("soma dos pesos é zero");
  const score = Math.round(criteria_scores.reduce((s, cs, i) => s + cs.score * criteria[i].weight, 0) / totalWeight);
  return { score, criteria_scores };
}

/** Versão dos critérios + contexto: mudou, todos os leads são reavaliados. */
export function criteriaVersion(context: string, criteria: Criterion[]): string {
  const canon = JSON.stringify({ context, criteria: criteria.map((c) => [c.id, c.name, c.description, c.weight]) });
  return createHash("sha256").update(canon).digest("hex").slice(0, 16);
}

/** Preço por milhão de tokens (US$). Padrão: Claude Haiku 4.5. */
export interface Prices { input: number; output: number }
export const HAIKU_4_5: Prices = { input: 1, output: 5 };

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/** Custo de uma chamada: escrita no cache custa 1,25x a entrada; leitura do cache, 0,1x. */
export function costUSD(u: Usage, p: Prices = HAIKU_4_5): number {
  const input = u.input_tokens + 1.25 * (u.cache_creation_input_tokens ?? 0) + 0.1 * (u.cache_read_input_tokens ?? 0);
  return (input * p.input + u.output_tokens * p.output) / 1_000_000;
}
