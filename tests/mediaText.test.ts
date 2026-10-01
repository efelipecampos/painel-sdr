import { describe, expect, it } from "vitest";
import { mergeText, pickMediaTarget } from "../src/media/mediaText.js";
import { parseAttachments } from "../src/poli/parser.js";
import { poliWebhookBodySchema } from "../src/poli/types.js";
import received from "./fixtures/received.json" with { type: "json" };

/** Formatos observados em eventos reais da Poli (2026-09-30). */
const audioReal = {
  type: "AUDIO",
  media: {
    url: "https://cdn.poli.digital/accounts/acc/messages/3793fdf2.ogg",
    mime_type: "audio/ogg; codecs=opus",
    resource_url: "https://cdn.poli.digital/accounts/acc/messages/3793fdf2.ogg",
  },
};
const imagemReal = {
  type: "IMAGE",
  media: {
    caption: "segue o print",
    url: "https://cdn.poli.digital/accounts/acc/messages/142e784f-image.png",
    file_name: "image",
    mime_type: "image/png",
  },
};
const figurinhaReal = {
  type: "STICKER",
  media: { url: "https://static.klipy.com/ii/abc/RpWaDxN8.webp", mime_type: "image/webp" },
};
const documentoReal = {
  type: "DOCUMENT",
  media: { url: "https://cdn.poli.digital/accounts/acc/messages/0493de73-doc.pdf", mime_type: "application/pdf" },
};

function attachmentsOf(...raw: object[]) {
  const body = structuredClone(received) as Record<string, any>;
  body.value.components = { attachments: raw };
  return parseAttachments(poliWebhookBodySchema.parse(body).value);
}

describe("parseAttachments", () => {
  it("lê url, mime e nome do formato real da Poli", () => {
    const [audio, imagem] = attachmentsOf(audioReal, imagemReal);

    expect(audio).toMatchObject({ type: "AUDIO", url: audioReal.media.url, mimeType: "audio/ogg; codecs=opus" });
    expect(imagem).toMatchObject({ type: "IMAGE", mimeType: "image/png", fileName: "image", caption: "segue o print" });
  });

  it("aceita a caixa inconsistente de type (audio/AUDIO, image/IMAGE)", () => {
    const [minusculo] = attachmentsOf({ type: "audio", media: { url: "https://cdn/x.ogg" }, mime_type: "audio/ogg" });

    expect(minusculo?.type).toBe("AUDIO");
    expect(pickMediaTarget([minusculo!])?.kind).toBe("audio");
  });
});

describe("pickMediaTarget", () => {
  it("escolhe áudio para transcrição", () => {
    expect(pickMediaTarget(attachmentsOf(audioReal))).toMatchObject({ kind: "audio", mimeType: "audio/ogg; codecs=opus" });
  });

  it("escolhe imagem para leitura", () => {
    expect(pickMediaTarget(attachmentsOf(imagemReal))).toMatchObject({ kind: "image", fileName: "image" });
  });

  it("prioriza áudio quando a mensagem tem os dois", () => {
    expect(pickMediaTarget(attachmentsOf(imagemReal, audioReal))?.kind).toBe("audio");
  });

  it("ignora figurinha e documento (decisão do usuário)", () => {
    expect(pickMediaTarget(attachmentsOf(figurinhaReal))).toBeUndefined();
    expect(pickMediaTarget(attachmentsOf(documentoReal))).toBeUndefined();
  });

  it("ignora anexo sem url", () => {
    expect(pickMediaTarget(attachmentsOf({ type: "AUDIO", media: { mime_type: "audio/ogg" } }))).toBeUndefined();
  });

  it("não devolve nada quando a mensagem é só texto", () => {
    expect(pickMediaTarget(parseAttachments(poliWebhookBodySchema.parse(received).value))).toBeUndefined();
  });
});

describe("mergeText", () => {
  it("usa o texto extraído quando a mensagem não tinha texto", () => {
    expect(mergeText("", "Bom dia, quero saber o preço")).toBe("Bom dia, quero saber o preço");
  });

  it("junta legenda e texto extraído", () => {
    expect(mergeText("segue o print", "Tela de erro do WhatsApp Business")).toBe(
      "segue o print\n\nTela de erro do WhatsApp Business",
    );
  });

  it("não duplica quando são iguais e não inventa texto quando a extração falhou", () => {
    expect(mergeText("igual", "igual")).toBe("igual");
    expect(mergeText("só a legenda", undefined)).toBe("só a legenda");
  });
});
