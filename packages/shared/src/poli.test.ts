import { describe, expect, it } from "vitest";
import { PoliApi, PoliError, toTemplate } from "./poli";

function fakeFetch(status: number, body: unknown, calls: { url: string; init: RequestInit }[]) {
  return (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

describe("PoliApi", () => {
  it("envia o template ao contato com o canal, a versão v3 e as variáveis na ordem", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const api = new PoliApi("https://x/v3/", "tok", fakeFetch(200, { uuid: "msg-1" }, calls));
    const id = await api.sendToContact("c-1", { templateUuid: "t-1", channelUuid: "ch-1", bodyParams: ["João", "Jessica"] });
    expect(id).toBe("msg-1");
    expect(calls[0].url).toBe("https://x/v3/contacts/c-1/messages");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      provider: "WHATSAPP", account_channel_uuid: "ch-1", type: "TEMPLATE", template_uuid: "t-1", version: "v3",
      components: { body: { parameters: [{ type: "text", text: "João" }, { type: "text", text: "Jessica" }] } },
    });
  });

  it("envia texto livre ao contato com tipo TEXT", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const api = new PoliApi("https://x/v3", "tok", fakeFetch(200, { uuid: "m2" }, calls));
    expect(await api.sendTextToContact("c-1", "ch-1", "Oi, João!")).toBe("m2");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      provider: "WHATSAPP", account_channel_uuid: "ch-1", type: "TEXT", version: "v3", direction: "OUT", components: { body: { text: "Oi, João!" } },
    });
  });

  it("erro vira PoliError com status e motivo curto, sem número de telefone", async () => {
    const api = new PoliApi("https://x/v3", "tok", fakeFetch(422, { message: "contato 5511999998888 inválido" }, []));
    const e = await api.sendToContact("c", { templateUuid: "t", channelUuid: "ch", bodyParams: [] }).catch((x) => x);
    expect(e).toBeInstanceOf(PoliError);
    expect(e.status).toBe(422);
    expect(e.reason).not.toMatch(/\d{8,}/);
  });

  it("lê só os botões de resposta do template", () => {
    expect(toTemplate({ uuid: "u", key: "k", message: { body: "Oi", buttons: [{ type: "reply", text: " Eu e mais 1 " }, { type: "url", text: "Site" }] } }))
      .toEqual({ uuid: "u", key: "k", status: null, category: null, body: "Oi", buttons: ["Eu e mais 1"], metaName: null });
    expect(toTemplate({ uuid: "u", message: "texto antigo" }).body).toBe("texto antigo");
  });
});
