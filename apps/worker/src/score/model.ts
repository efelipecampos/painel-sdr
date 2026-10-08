// Chamada ao modelo para dar nota a um lead (Fase 7). O modelo vem de ANTHROPIC_MODEL.
import Anthropic from "@anthropic-ai/sdk";
import {
  costUSD, outputSchema, scoreFromAnswer, systemPrompt, type Criterion, type CriterionScore, type ModelAnswer, type Usage,
} from "./rules.js";

export interface LeadScore {
  score: number;
  criteria_scores: CriterionScore[];
  summary: string;
  usage: Usage;
  cost: number;
}

export async function scoreConversation(
  client: Anthropic, model: string, context: string, criteria: Criterion[], transcript: string,
): Promise<LeadScore> {
  const res = await client.messages.create({
    model,
    max_tokens: 2000,
    system: systemPrompt(context, criteria),
    messages: [{ role: "user", content: `Avalie este lead pela conversa abaixo.\n\n<conversa>\n${transcript}\n</conversa>` }],
    output_config: { format: { type: "json_schema", schema: outputSchema(criteria) } },
  });
  if (res.stop_reason === "refusal") throw new Error("o modelo recusou a avaliação");
  if (res.stop_reason === "max_tokens") throw new Error("resposta do modelo cortada (max_tokens)");
  const text = res.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text;
  if (!text) throw new Error("resposta do modelo sem texto");
  const answer = JSON.parse(text) as ModelAnswer;
  const { score, criteria_scores } = scoreFromAnswer(criteria, answer);
  return { score, criteria_scores, summary: answer.resumo, usage: res.usage, cost: costUSD(res.usage) };
}
