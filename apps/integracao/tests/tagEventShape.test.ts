import { describe, expect, it } from "vitest";
import { describeShape } from "../src/webhookHandler.js";

describe("describeShape (formato do evento de tag, só estrutura)", () => {
  it("dá o tipo de cada caminho e só o uuid/nome de dentro da tag; nada do contato", () => {
    const { shape, tagValues } = describeShape({
      object: "contact", event: "tag_linked", uuid: "c-1",
      value: { name: "Fulano", phone: "5511999999999", tags: [{ uuid: "t-1", attributes: { name: "Descarte - Sem CNPJ" } }] },
    });
    expect(shape).toMatchObject({ object: "string", "value.name": "string", "value.phone": "string", "value.tags": "array(1)", "value.tags[0].uuid": "string" });
    expect(tagValues).toEqual({ "value.tags[0].uuid": "t-1", "value.tags[0].attributes.name": "Descarte - Sem CNPJ" });
    expect(JSON.stringify({ shape, tagValues })).not.toMatch(/Fulano|5511999999999/);
  });
});
