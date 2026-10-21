import { describe, expect, it } from "vitest";
import { idPoli, normalizar, paraLinha, passouPorSdr, type PoliMensagem } from "./regras.js";

const sdrs = new Set(["Isadora Rocha", "Leticia Bezerra"].map(normalizar));
const base = (x: Partial<PoliMensagem>): PoliMensagem => ({ uuid: "m1", metadata: { created_at: "2025-11-10T12:00:00.000000Z" }, ...x });

describe("passouPorSdr", () => {
  it("SDR dona do atendimento", () => {
    expect(passouPorSdr(base({ direction: "IN", attendance: { attendant: { attributes: { name: "Isadora Rocha" } } } }), sdrs)).toBe(true);
  });
  it("SDR que escreveu, com acento e caixa diferentes", () => {
    expect(passouPorSdr(base({ direction: "OUT", author: { type: "USER", attributes: { name: "LETÍCIA  Bezerra" } } }), sdrs)).toBe(true);
  });
  it("contato redirecionado para a SDR (aviso do sistema)", () => {
    const m = base({ direction: "SYSTEM", components: { body: { text: "Contato redirecionado para Isadora Rocha por Iago Leal" } } });
    expect(passouPorSdr(m, sdrs)).toBe(true);
  });
  it("SDR só como quem redirecionou para outra pessoa não conta", () => {
    const m = base({ direction: "SYSTEM", components: { body: { text: "Contato redirecionado para Iago Leal por Isadora Rocha" } } });
    expect(passouPorSdr(m, sdrs)).toBe(false);
  });
  it("nome do contato igual ao de uma SDR não conta", () => {
    expect(passouPorSdr(base({ direction: "IN", author: { type: "CONTACT", attributes: { name: "Isadora Rocha" } } }), sdrs)).toBe(false);
  });
  it("atendimento de outro time não conta", () => {
    expect(passouPorSdr(base({ direction: "OUT", attendance: { attendant: { attributes: { name: "Suporte" } } } }), sdrs)).toBe(false);
  });
});

describe("paraLinha", () => {
  it("não guarda o nome do contato e leva texto, template e botões", () => {
    const l = paraLinha(base({ direction: "IN", type: "CHAT", author: { type: "CONTACT", uuid: "c1", attributes: { name: "Fulano" } }, components: { body: { text: "oi" }, buttons: [] } }), "c1");
    expect(l).toMatchObject({ poli_contact_uuid: "c1", direcao: "IN", autor_nome: null, autor_uuid: idPoli("c1"), texto: "oi", botoes: null });
    const t = paraLinha(base({ direction: "OUT", template: { name: "corte" }, components: { buttons: [{ text: "Sim" }] } }), "c1");
    expect(t).toMatchObject({ template_nome: "corte", botoes: [{ text: "Sim" }] });
  });
  it("sem data não vira linha", () => {
    expect(paraLinha({ uuid: "m1" }, "c1")).toBeNull();
  });
});

describe("idPoli", () => {
  it("uuid passa igual; id fora do formato vira uuid fixo, sem o telefone", () => {
    expect(idPoli("9AFFD173-6160-4da2-9697-e04f95941d1a")).toBe("9affd173-6160-4da2-9697-e04f95941d1a");
    const a = idPoli("sys-0-11000-5511999990000-msg-17925836126908-");
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(a).not.toContain("5511999990000");
    expect(idPoli("sys-0-11000-5511999990000-msg-17925836126908-")).toBe(a);
    expect(idPoli(null)).toBeNull();
  });
});
