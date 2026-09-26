import { describe, expect, it } from "vitest";
import { isProspectingOpener } from "../src/config/prospectingTemplates.js";
import {
  CYCLE_HOURS,
  CYCLE_REPLIED_AT,
  CYCLE_START_AT,
  CYCLE_TEMPLATE,
  planCycleUpdate,
} from "../src/pipeline/prospectingCycle.js";
import type { MessageEvent } from "../src/poli/parser.js";

const base: MessageEvent = {
  externalMessageId: "wamid.1",
  direction: "OUT",
  timestampMs: 1_790_000_000_000,
  text: "Olá",
  leadPhone: "5516997220323",
  leadUuid: "a21bb5bf-8b92-4bc3-859e-b48f130970f8",
  isTemplate: false,
};

const opener: MessageEvent = {
  ...base,
  isTemplate: true,
  templateName: "aberturadomilhão",
};

describe("isProspectingOpener", () => {
  it("reconhece as grafias diferentes do mesmo template de abertura", () => {
    for (const name of [
      "aberturadomilhão",
      "aberturademilhao",
      " aberturademilhao_foradoexpediente",
      "#abertura_concorrente_gatilho1",
      "abertura_concorrente_gatilho1",
    ]) {
      expect(isProspectingOpener(name), name).toBe(true);
    }
  });

  it("não considera outros templates nem mensagem sem template", () => {
    expect(isProspectingOpener("SDR_DIA01_NEW")).toBe(false);
    expect(isProspectingOpener("#Dia1Maria")).toBe(false);
    expect(isProspectingOpener(undefined)).toBe(false);
  });
});

describe("planCycleUpdate", () => {
  it("abre um ciclo no disparo do template de abertura e limpa o ciclo anterior", () => {
    const plan = planCycleUpdate({ startedAtMs: 1, repliedAtMs: 2 }, opener);

    expect(plan.properties[CYCLE_START_AT]).toBe(String(opener.timestampMs));
    expect(plan.properties[CYCLE_TEMPLATE]).toBe("aberturadomilhão");
    expect(plan.properties[CYCLE_REPLIED_AT]).toBe("");
    expect(plan.properties[CYCLE_HOURS]).toBe("");
    expect(plan.completed).toBeUndefined();
  });

  it("ignora mensagem enviada que não é template de abertura", () => {
    expect(planCycleUpdate({}, base).properties).toEqual({});
    expect(planCycleUpdate({}, { ...base, isTemplate: true, templateName: "SDR_DIA01_NEW" }).properties).toEqual({});
  });

  it("fecha o ciclo na primeira resposta do lead e calcula as horas", () => {
    const startedAtMs = opener.timestampMs;
    const reply: MessageEvent = { ...base, direction: "IN", timestampMs: startedAtMs + 5_400_000 };

    const plan = planCycleUpdate({ startedAtMs }, reply);

    expect(plan.properties[CYCLE_REPLIED_AT]).toBe(String(reply.timestampMs));
    expect(plan.properties[CYCLE_HOURS]).toBe("1.5");
    expect(plan.completed).toMatchObject({ startedAtMs, repliedAtMs: reply.timestampMs, hours: 1.5 });
  });

  it("não sobrescreve a primeira resposta com as seguintes", () => {
    const startedAtMs = opener.timestampMs;
    const segunda: MessageEvent = { ...base, direction: "IN", timestampMs: startedAtMs + 7_200_000 };

    expect(planCycleUpdate({ startedAtMs, repliedAtMs: startedAtMs + 60_000 }, segunda).properties).toEqual({});
  });

  it("ignora resposta quando não houve disparo visto pela integração", () => {
    const reply: MessageEvent = { ...base, direction: "IN" };

    expect(planCycleUpdate({}, reply).properties).toEqual({});
  });

  it("ignora mensagem do lead anterior ao disparo", () => {
    const startedAtMs = opener.timestampMs;
    const anterior: MessageEvent = { ...base, direction: "IN", timestampMs: startedAtMs - 60_000 };

    expect(planCycleUpdate({ startedAtMs }, anterior).properties).toEqual({});
  });
});
