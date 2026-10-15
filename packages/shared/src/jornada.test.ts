import { describe, expect, it } from "vitest";
import { botaoClicado, escolherRegra, preencher, previa, variaveis, variaveisDesconhecidas, type Regra } from "./jornada";

const regra = (p: Partial<Regra>): Regra => ({
  id: "r", origin_template_uuid: "abertura", origin_button: "Eu e mais 1", janela: "sempre",
  dest_template_uuid: "fim", status: "ativa", daily_limit: null, ...p,
});

describe("botaoClicado", () => {
  it("reconhece o botão sem ligar para maiúsculas e espaços", () => {
    expect(botaoClicado("  eu e  MAIS 1 ", ["Eu e mais 1", "3 ou mais"])).toBe("Eu e mais 1");
  });
  it("texto livre não é clique", () => {
    expect(botaoClicado("somos 5 pessoas", ["Eu e mais 1", "3 ou mais"])).toBeNull();
    expect(botaoClicado(null, ["Eu e mais 1"])).toBeNull();
  });
});

describe("escolherRegra", () => {
  const sempre = regra({ id: "sempre" });
  const fora = regra({ id: "fora", janela: "fora", origin_button: "3 ou mais" });
  const foraSempre = regra({ id: "3-sempre", janela: "sempre", origin_button: "3 ou mais" });

  it("acha a regra do template e do botão", () => {
    expect(escolherRegra([sempre], "abertura", "eu e mais 1", true)?.id).toBe("sempre");
  });
  it("regra do horário exato vence a de sempre", () => {
    expect(escolherRegra([foraSempre, fora], "abertura", "3 ou mais", false)?.id).toBe("fora");
    expect(escolherRegra([foraSempre, fora], "abertura", "3 ou mais", true)?.id).toBe("3-sempre");
  });
  it("regra de expediente não vale fora do expediente", () => {
    expect(escolherRegra([regra({ janela: "expediente" })], "abertura", "Eu e mais 1", false)).toBeNull();
  });
  it("ignora regra pausada e template diferente", () => {
    expect(escolherRegra([regra({ status: "pausada" })], "abertura", "Eu e mais 1", true)).toBeNull();
    expect(escolherRegra([sempre], "outro", "Eu e mais 1", true)).toBeNull();
  });
  it("regra em teste continua valendo (o worker manda para o telefone de teste)", () => {
    expect(escolherRegra([regra({ status: "teste" })], "abertura", "Eu e mais 1", true)?.status).toBe("teste");
  });
});

describe("variáveis", () => {
  const texto = "Oi, [contact_first_name]! Aqui é [operator_name], da Poli.";
  it("lista na ordem do texto", () => {
    expect(variaveis(texto)).toEqual(["contact_first_name", "operator_name"]);
  });
  it("aponta as que o painel não sabe preencher", () => {
    expect(variaveisDesconhecidas("Oi [contact_first_name], seu e-mail é [contact_email]")).toEqual(["contact_email"]);
    expect(variaveisDesconhecidas(texto)).toEqual([]);
  });
  it("preenche com o primeiro nome do lead e da SDR", () => {
    expect(preencher(texto, { leadNome: "João da Silva", sdrNome: "Jessica Ferreira" })).toEqual({ ok: true, params: ["João", "Jessica"] });
    expect(previa(texto, { leadNome: "João da Silva", sdrNome: "Jessica Ferreira" })).toBe("Oi, João! Aqui é Jessica, da Poli.");
  });
  it("não manda variável vazia: sem SDR ou com nome que é só telefone, diz o que faltou", () => {
    expect(preencher(texto, { leadNome: "João", sdrNome: null })).toEqual({ ok: false, falta: "operator_name" });
    expect(preencher(texto, { leadNome: "55 11 99999-0000", sdrNome: "Jessica" })).toEqual({ ok: false, falta: "contact_first_name" });
  });
  it("template sem variável não precisa de dado nenhum", () => {
    expect(preencher("Obrigado!", { leadNome: null, sdrNome: null })).toEqual({ ok: true, params: [] });
  });
});
