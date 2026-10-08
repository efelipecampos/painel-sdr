import { describe, expect, it } from "vitest";
import { CelerisError, celerisScorer, scorerFromEnv } from "./model.js";

function fakeFetch(responses: { status: number; body: unknown }[]) {
  const calls: { url: string; body: any; auth: string }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)), auth: (init.headers as Record<string, string>).Authorization });
    const r = responses.shift()!;
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const ok = (content: string) => ({
  status: 200,
  body: { choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 100 } } },
});

describe("Celeris", () => {
  it("manda o pedido no formato da OpenAI, com o schema e sem raciocínio, e calcula o custo", async () => {
    const f = fakeFetch([ok('{"a":1}')]);
    const s = celerisScorer("celeris-1", "chave", "https://x/v1/", f.fn);
    const r = await s.call("sistema", "conversa", { type: "object" });
    expect(f.calls[0].url).toBe("https://x/v1/chat/completions");
    expect(f.calls[0].auth).toBe("Bearer chave");
    expect(f.calls[0].body).toMatchObject({
      model: "celeris-1", temperature: 0,
      messages: [{ role: "system", content: "sistema" }, { role: "user", content: "conversa" }],
      response_format: { type: "json_schema", json_schema: { name: "avaliacao_lead", schema: { type: "object" } } },
      chat_template_kwargs: { enable_thinking: false },
    });
    expect(r.text).toBe('{"a":1}');
    expect(r.usage).toEqual({ input_tokens: 900, output_tokens: 200, cache_read_input_tokens: 100 });
    // 900 × 0,20 + 100 × 0,02 + 200 × 0,70, por milhão
    expect(r.cost).toBeCloseTo((900 * 0.2 + 100 * 0.02 + 200 * 0.7) / 1e6, 10);
  });
  it("chave errada ou sem crédito aborta a rodada; resposta cortada é erro do lead", async () => {
    const s = celerisScorer("celeris-1", "x", "https://x/v1", fakeFetch([{ status: 401, body: "unauthorized" }]).fn);
    const err = await s.call("", "", {}).catch((e) => e);
    expect(err).toBeInstanceOf(CelerisError);
    expect(s.fatal(err)).toBe(true);
    const cut = celerisScorer("celeris-1", "x", "https://x/v1", fakeFetch([{ status: 200, body: { choices: [{ message: { content: "{" }, finish_reason: "length" }] } }]).fn);
    const e2 = await cut.call("", "", {}).catch((e) => e);
    expect(e2.message).toMatch(/cortada/);
    expect(cut.fatal(e2)).toBe(false);
  });
});

describe("escolha da IA pelo .env", () => {
  it("celeris com chave; sem chave não roda; padrão é anthropic", () => {
    expect(scorerFromEnv({ SCORE_IA: "celeris", CELERIS_API_KEY: "k" })?.model).toBe("celeris-1");
    expect(scorerFromEnv({ SCORE_IA: "celeris", CELERIS_API_KEY: "k", CELERIS_MODEL: "celeris-1-magnus" })?.model).toBe("celeris-1-magnus");
    expect(scorerFromEnv({ SCORE_IA: "celeris" })).toBeNull();
    expect(scorerFromEnv({ ANTHROPIC_MODEL: "claude-haiku-4-5" })).toBeNull();
    expect(scorerFromEnv({ ANTHROPIC_MODEL: "claude-haiku-4-5", ANTHROPIC_API_KEY: "k" })?.ia).toBe("anthropic");
    expect(() => scorerFromEnv({ SCORE_IA: "outra" })).toThrow(/SCORE_IA/);
  });
});
