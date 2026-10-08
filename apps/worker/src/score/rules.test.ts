import { describe, expect, it } from "vitest";
import {
  DEFAULT_CRITERIA, buildTranscript, leadMessageCount, costUSD, criteriaVersion, maskPII, outputSchema, scoreFromAnswer, systemPrompt,
  type TranscriptMessage,
} from "./rules";

const msg = (sender: TranscriptMessage["sender"], body: string | null, sent_at = "2026-10-07T13:00:00Z", template_name: string | null = null): TranscriptMessage =>
  ({ sender, body, sent_at, template_name });

describe("maskPII", () => {
  it("mascara telefone e e-mail", () => {
    expect(maskPII("me liga no (11) 98765-4321 ou +55 11 987654321")).toBe("me liga no [telefone] ou [telefone]");
    expect(maskPII("manda para joao.silva@empresa.com.br")).toBe("manda para [e-mail]");
  });
  it("não mexe em números curtos (quantidade de atendentes, horário, valores)", () => {
    expect(maskPII("somos 12 atendentes, das 8 às 18, uns 1.500 contatos")).toBe("somos 12 atendentes, das 8 às 18, uns 1.500 contatos");
  });
});

describe("buildTranscript", () => {
  it("formata quem falou, no fuso de São Paulo, e tira eventos do sistema", () => {
    const t = buildTranscript([
      msg("template", null, "2026-10-07T12:00:00Z", "boas_vindas"),
      msg("system", "transferido"),
      msg("lead", "Oi, temos 5 atendentes", "2026-10-07T13:05:00Z"),
      msg("sdr", "Legal! Qual a maior dificuldade?", "2026-10-07T13:06:00Z"),
      msg("lead", null, "2026-10-07T13:07:00Z"),
    ]);
    expect(t).toBe([
      '[07/10, 09:00] Template: (modelo "boas_vindas")',
      "[07/10, 10:05] Lead: Oi, temos 5 atendentes",
      "[07/10, 10:06] SDR: Legal! Qual a maior dificuldade?",
      "[07/10, 10:07] Lead: (mídia ou mensagem sem texto)",
    ].join("\n"));
  });
  it("mascara telefone dentro da conversa", () => {
    expect(buildTranscript([msg("lead", "meu número é 11 98765-4321")])).toContain("Lead: meu número é [telefone]");
  });
  it("guarda só as mensagens mais recentes quando passa do limite", () => {
    const many = Array.from({ length: 10 }, (_, i) => msg("lead", `mensagem ${i}`));
    const t = buildTranscript(many, 3);
    expect(t.split("\n")).toEqual([
      "(mensagens anteriores omitidas)",
      expect.stringContaining("mensagem 7"), expect.stringContaining("mensagem 8"), expect.stringContaining("mensagem 9"),
    ]);
    const short = buildTranscript(many, 80, 60);
    expect(short).toContain("mensagem 9");
    expect(short).not.toContain("mensagem 0");
  });
});

describe("leadMessageCount", () => {
  const at = (s: number) => new Date(Date.parse("2026-10-07T13:00:00Z") + s * 1000).toISOString();
  it("conta só mensagens do lead", () => {
    expect(leadMessageCount([msg("template", null, at(0), "x"), msg("lead", "oi", at(60)), msg("sdr", "olá", at(120)), msg("lead", "tudo bem?", at(180))])).toBe(2);
  });
  it("resposta em até 10 s depois de mensagem nossa é automática", () => {
    expect(leadMessageCount([msg("template", null, at(0), "x"), msg("lead", "Obrigado pelo contato! Já te respondemos.", at(3)), msg("lead", "oi", at(600))])).toBe(1);
  });
  it("texto repetido conta uma vez; mídia sem texto conta", () => {
    expect(leadMessageCount([msg("lead", "Olá!", at(0)), msg("lead", "olá!", at(100)), msg("lead", null, at(200))])).toBe(2);
  });
  it("eventos do sistema não contam como mensagem nossa", () => {
    expect(leadMessageCount([msg("lead", "a", at(0)), msg("system", "transferido", at(100)), msg("lead", "b", at(105))])).toBe(2);
  });
});

describe("scoreFromAnswer", () => {
  const answer = (notas: (number | null)[]) => ({
    criterios: notas.map((nota, i) => ({ criterio: `c${i + 1}`, sem_informacao: nota === null, nota: nota ?? 0, justificativa: "x" })),
    resumo: "r",
  });

  it("nota final é a média ponderada (pesos 3, 3, 2, 2, 2)", () => {
    const r = scoreFromAnswer(DEFAULT_CRITERIA, answer([100, 50, 0, 100, 50]));
    // (300 + 150 + 0 + 200 + 100) / 12 = 62,5 → 63
    expect(r.score).toBe(63);
    expect(r.criteria_scores.map((c) => c.criterion_id)).toEqual(["engajamento", "porte", "dor", "intencao", "encaixe"]);
  });
  it("critério sem informação fica fora da média", () => {
    // só Engajamento (3) = 20 e Intenção (2) = 70 têm informação: (60 + 140) / 5 = 40
    const r = scoreFromAnswer(DEFAULT_CRITERIA, answer([20, null, null, 70, null]));
    expect(r.score).toBe(40);
    expect(r.criteria_scores.map((c) => c.score)).toEqual([20, null, null, 70, null]);
  });
  it("sem informação em nenhum critério: sem nota", () => {
    expect(scoreFromAnswer(DEFAULT_CRITERIA, answer([null, null, null, null, null])).score).toBeNull();
  });
  it("limita cada nota entre 0 e 100", () => {
    const r = scoreFromAnswer(DEFAULT_CRITERIA, answer([150, -10, 50, 50, 50]));
    expect(r.criteria_scores.map((c) => c.score)).toEqual([100, 0, 50, 50, 50]);
  });
  it("falha se o modelo não avaliou algum critério", () => {
    expect(() => scoreFromAnswer(DEFAULT_CRITERIA, answer([50, 50, 50, 50]))).toThrow("Encaixe no produto");
  });
});

describe("pedido ao modelo", () => {
  it("lista os critérios com chaves curtas, e o formato aceita só essas chaves", () => {
    expect(systemPrompt("Contexto X", DEFAULT_CRITERIA)).toContain("- c2 — Porte:");
    const s = outputSchema(DEFAULT_CRITERIA) as { properties: { criterios: { items: { properties: { criterio: { enum: string[] } } } } } };
    expect(s.properties.criterios.items.properties.criterio.enum).toEqual(["c1", "c2", "c3", "c4", "c5"]);
  });
  it("versão muda quando muda peso, descrição ou contexto", () => {
    const v = criteriaVersion("ctx", DEFAULT_CRITERIA);
    expect(criteriaVersion("ctx", DEFAULT_CRITERIA)).toBe(v);
    expect(criteriaVersion("ctx2", DEFAULT_CRITERIA)).not.toBe(v);
    expect(criteriaVersion("ctx", [{ ...DEFAULT_CRITERIA[0], weight: 1 }, ...DEFAULT_CRITERIA.slice(1)])).not.toBe(v);
  });
});

describe("costUSD", () => {
  it("Haiku 4.5: US$ 1 por milhão de entrada, US$ 5 de saída, cache a 1,25x e 0,1x", () => {
    expect(costUSD({ input_tokens: 1_000_000, output_tokens: 0 })).toBeCloseTo(1);
    expect(costUSD({ input_tokens: 0, output_tokens: 1_000_000 })).toBeCloseTo(5);
    expect(costUSD({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 })).toBeCloseTo(0.1);
    expect(costUSD({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000 })).toBeCloseTo(1.25);
  });
});
