// Chamada à IA que dá nota a um lead (Fase 7). Duas opções, escolhidas por SCORE_IA no .env:
//  * anthropic: Claude pelo SDK oficial (ANTHROPIC_API_KEY, ANTHROPIC_MODEL);
//  * celeris: Celeris, a IA que a Poli usa, pela API no formato da OpenAI (CELERIS_API_KEY, CELERIS_MODEL).
// As duas recebem o mesmo prompt e o mesmo formato de resposta (JSON com schema fixo).
import Anthropic from "@anthropic-ai/sdk";
import {
  costUSD, outputSchema, scoreFromAnswer, systemPrompt, type Criterion, type CriterionScore, type ModelAnswer, type Prices, type Usage,
} from "./rules.js";

export interface LeadScore {
  score: number | null;
  criteria_scores: CriterionScore[];
  summary: string;
  existingCustomer: boolean;
  usage: Usage;
  cost: number;
}

export interface Scorer {
  /** Nome curto da IA, para log e teste. */
  ia: "anthropic" | "celeris";
  /** Modelo, gravado em lead_scores.model. */
  model: string;
  call(system: string, user: string, schema: { [key: string]: unknown }): Promise<{ text: string; usage: Usage; cost: number }>;
  /** Erro que não adianta repetir com o próximo lead (chave errada, sem permissão, sem crédito): aborta a rodada. */
  fatal(err: unknown): boolean;
}

export function anthropicScorer(model: string, client = new Anthropic()): Scorer {
  return {
    ia: "anthropic",
    model,
    async call(system, user, schema) {
      const res = await client.messages.create({
        model,
        max_tokens: 2000,
        system,
        messages: [{ role: "user", content: user }],
        output_config: { format: { type: "json_schema", schema } },
      });
      if (res.stop_reason === "refusal") throw new Error("o modelo recusou a avaliação");
      if (res.stop_reason === "max_tokens") throw new Error("resposta do modelo cortada (max_tokens)");
      const text = res.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text;
      if (!text) throw new Error("resposta do modelo sem texto");
      return { text, usage: res.usage, cost: costUSD(res.usage) };
    },
    fatal: (err) => err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError,
  };
}

/** Preço da Celeris por milhão de tokens (docs.celeris.ai/pricing, 08/10/2026): celeris-1 e celeris-1-magnus. */
export const CELERIS_1: Prices = { input: 0.2, output: 0.7 };
export const CELERIS_URL = "https://inference.celeris.ai/celeris-1/v1";

export class CelerisError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function celerisScorer(model: string, apiKey: string, baseUrl = CELERIS_URL, fetchFn: typeof fetch = fetch): Scorer {
  async function post(body: unknown): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetchFn(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
      // Limite de uso ou instabilidade: espera e tenta de novo (até 3 vezes).
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        await new Promise((r) => setTimeout(r, 2_000 * 2 ** attempt));
        continue;
      }
      return res;
    }
  }
  return {
    ia: "celeris",
    model,
    async call(system, user, schema) {
      const res = await post({
        model,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        max_tokens: 2000,
        temperature: 0,
        response_format: { type: "json_schema", json_schema: { name: "avaliacao_lead", schema } },
        chat_template_kwargs: { enable_thinking: false },
      });
      if (!res.ok) {
        // A resposta de erro não traz dado do lead; corta para não encher o log.
        const detail = (await res.text().catch(() => "")).slice(0, 300);
        throw new CelerisError(res.status, `Celeris respondeu ${res.status}: ${detail}`);
      }
      const data = await res.json() as {
        choices?: { message?: { content?: string | null }; finish_reason?: string }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } | null };
      };
      const choice = data.choices?.[0];
      if (choice?.finish_reason === "length") throw new Error("resposta do modelo cortada (max_tokens)");
      const text = choice?.message?.content;
      if (!text) throw new Error("resposta do modelo sem texto");
      const cached = data.usage?.prompt_tokens_details?.cached_tokens ?? 0;
      const usage: Usage = { input_tokens: (data.usage?.prompt_tokens ?? 0) - cached, output_tokens: data.usage?.completion_tokens ?? 0, cache_read_input_tokens: cached };
      return { text, usage, cost: costUSD(usage, CELERIS_1) };
    },
    fatal: (err) => err instanceof CelerisError && [401, 402, 403].includes(err.status),
  };
}

/** A IA escolhida no .env, ou null se faltar chave ou modelo (o score não roda). */
export function scorerFromEnv(env: NodeJS.ProcessEnv = process.env): Scorer | null {
  const ia = env.SCORE_IA?.trim().toLowerCase() || "anthropic";
  if (ia === "celeris") {
    const key = env.CELERIS_API_KEY?.trim();
    return key ? celerisScorer(env.CELERIS_MODEL?.trim() || "celeris-1", key, env.CELERIS_URL?.trim() || CELERIS_URL) : null;
  }
  if (ia !== "anthropic") throw new Error(`SCORE_IA inválido: ${ia} (use anthropic ou celeris)`);
  const model = env.ANTHROPIC_MODEL?.trim();
  return model && env.ANTHROPIC_API_KEY?.trim() ? anthropicScorer(model) : null;
}

export async function scoreConversation(scorer: Scorer, context: string, criteria: Criterion[], transcript: string): Promise<LeadScore> {
  const { text, usage, cost } = await scorer.call(
    systemPrompt(context, criteria),
    `Avalie este lead pela conversa abaixo.\n\n<conversa>\n${transcript}\n</conversa>`,
    outputSchema(criteria),
  );
  let answer: ModelAnswer;
  try {
    answer = JSON.parse(text) as ModelAnswer;
  } catch {
    throw new Error("resposta do modelo não é um JSON válido");
  }
  const { score, criteria_scores } = scoreFromAnswer(criteria, answer);
  return { score, criteria_scores, summary: answer.resumo, existingCustomer: answer.ja_e_cliente, usage, cost };
}
