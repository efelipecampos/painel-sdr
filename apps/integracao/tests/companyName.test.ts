import { describe, expect, it } from "vitest";
import { extractCompanyFromLeadName } from "../src/hubspot/companyName.js";

describe("extractCompanyFromLeadName", () => {
  it("extrai empresa depois de ' - ', ignorando sufixo de id", () => {
    expect(extractCompanyFromLeadName("Ariely - Casa de Carnes Nelore")).toBe("Casa de Carnes Nelore");
    expect(extractCompanyFromLeadName("Jaqueline - Iguarias da Canastra")).toBe("Iguarias da Canastra");
    expect(extractCompanyFromLeadName("Pedro Damascena -  CENTRO EDUCACIONAL CONEXAO")).toBe(
      "CENTRO EDUCACIONAL CONEXAO",
    );
  });

  it("extrai empresa depois de ' | ', removendo o id no final", () => {
    expect(extractCompanyFromLeadName("Reginaldo | Solart - 34395")).toBe("Solart");
  });

  it("extrai empresa depois de '+'", () => {
    expect(extractCompanyFromLeadName("JOSE DELIOMAR DA SILVA SANTOS + Hospital Santa Efigenia")).toBe(
      "Hospital Santa Efigenia",
    );
  });

  it("usa o texto inteiro (sem id) quando não há separador reconhecido", () => {
    expect(extractCompanyFromLeadName("Lofts Incorporações - #52378")).toBe("Lofts Incorporações");
  });

  it("retorna null pra nome vazio/indefinido", () => {
    expect(extractCompanyFromLeadName(undefined)).toBeNull();
    expect(extractCompanyFromLeadName("")).toBeNull();
  });

  it("normaliza letras estilizadas, que o HubSpot recusa na busca", () => {
    expect(extractCompanyFromLeadName("Maria - 𝐏𝐫𝐨𝐝𝐮𝐭𝐨𝐬 𝐍𝐚𝐭𝐮𝐫𝐚𝐢𝐬")).toBe("Produtos Naturais");
    expect(extractCompanyFromLeadName("𝐀𝐜𝐦𝐞 𝐋𝐭𝐝𝐚")).toBe("Acme Ltda");
  });
});
