// Payloads com o formato real da Poli (chaves e valores categóricos vistos em public.raw_events),
// com ids, nomes, telefones e textos fictícios.
import { describe, expect, it } from "vitest";
import { parsePoliEvent, toE164 } from "./event";

const OWNER = { uuid: "owner-1", email: "Sdr.Um@Poli.Digital", attributes: { name: "SDR Um" } };

function payload(value: Record<string, unknown>) {
  return {
    object: "message",
    event: "sent",
    uuid: "evt-1",
    account_uuid: "acc-1",
    value: {
      uuid: "msg-1",
      event: "MESSAGE",
      direction: "OUT",
      type: "CHAT",
      timestamp: 1790849278,
      ack: "CREATED",
      author: { type: "USER", uuid: "owner-1", attributes: { name: "SDR Um" } },
      contact: { uuid: "contact-1", attributes: { name: "Lead Fictício", phone: "5511999990000" } },
      attendance: { uuid: "att-1", status: "IN_PROGRESS", type: "INITIATED_BY_BUSINESS", closed_reason: null, attendant: OWNER },
      components: { body: { text: "texto fictício" } },
      metadata: { external_message_id: "wamid.fake", direction: "OUT", created_at: "2026-10-02" },
      template: null,
      ...value,
    },
  };
}

describe("parsePoliEvent", () => {
  it("mensagem do lead", () => {
    const e = parsePoliEvent(payload({ direction: "IN", type: "TEXT", author: { type: "CONTACT", uuid: "contact-1" } }))!;
    expect(e.sender).toBe("lead");
    expect(e.byHuman).toBe(false);
    expect(e.owner).toEqual({ uuid: "owner-1", email: "sdr.um@poli.digital", name: "SDR Um" });
  });

  it("mensagem escrita pelo dono do chat", () => {
    const e = parsePoliEvent(payload({}))!;
    expect(e).toMatchObject({ sender: "sdr", byHuman: true, authorUuid: "owner-1", body: "texto fictício" });
    expect(e.sentAt.toISOString()).toBe(new Date(1790849278 * 1000).toISOString());
    expect(e.externalMessageId).toBe("wamid.fake");
  });

  it("mensagem escrita por outra pessoa da equipe no chat do dono", () => {
    const e = parsePoliEvent(payload({ author: { type: "USER", uuid: "gestor-1", attributes: { name: "Gestor" } } }))!;
    expect(e).toMatchObject({ sender: "sdr", byHuman: true, authorUuid: "gestor-1" });
    expect(e.owner?.uuid).toBe("owner-1");
  });

  it("template enviado manualmente por uma pessoa", () => {
    const e = parsePoliEvent(payload({ type: "TEMPLATE", components: null, template: { key: "SDR_DIA1_01", type: "WABA", message: "olá" } }))!;
    expect(e).toMatchObject({ sender: "template", byHuman: true, templateName: "SDR_DIA1_01", body: "olá" });
  });

  it("template do app token (autor sem uuid)", () => {
    const e = parsePoliEvent(payload({
      type: "TEMPLATE", components: null, author: { type: "USER", uuid: null, attributes: { name: null } },
      template: { key: "D2_dor_manha", type: "WABA" },
    }))!;
    expect(e).toMatchObject({ sender: "template", byHuman: false, authorUuid: null, templateName: "D2_dor_manha" });
  });

  it("mensagem automática sem autor", () => {
    const e = parsePoliEvent(payload({ author: { type: "USER", uuid: null }, attendance: { uuid: "att-1", status: "CLOSED", attendant: OWNER } }))!;
    expect(e).toMatchObject({ sender: "bot", byHuman: false, attendanceStatus: "CLOSED" });
  });

  it.each([
    ["SYSTEM", "ATTENDANCE_REDIRECTED", "MESSAGE"],
    ["SYSTEM", "ATTENDANCE_CLOSED", "SYSTEM"],
    ["SYSTEM", "NOTE", "MESSAGE"],
    ["SYSTEM", "SUMMARY", "SUMMARIZE"],
    ["EMPTY", "ATTENDANCE_REDIRECTED", "SYSTEM"],
  ])("evento de sistema %s/%s não guarda texto", (direction, type, event) => {
    const e = parsePoliEvent(payload({ direction, type, event }))!;
    expect(e).toMatchObject({ sender: "system", systemType: type, byHuman: false, body: null });
  });

  it("guarda status, tipo e motivo de encerramento do atendimento", () => {
    const e = parsePoliEvent(payload({
      direction: "SYSTEM", type: "ATTENDANCE_CLOSED", event: "SYSTEM",
      attendance: { uuid: "att-1", status: "CLOSED", type: "INITIATED_BY_FORWARDING", closed_reason: "FINISHED_BY_USER", attendant: OWNER },
    }))!;
    expect(e).toMatchObject({ attendanceStatus: "CLOSED", attendanceType: "INITIATED_BY_FORWARDING", closedReason: "FINISHED_BY_USER" });
  });

  it("chat sem dono", () => {
    const e = parsePoliEvent(payload({ attendance: { uuid: "att-1", status: "QUEUE", attendant: null } }))!;
    expect(e.owner).toBeNull();
  });

  it("mídia sem texto vira o tipo entre colchetes", () => {
    const e = parsePoliEvent(payload({ direction: "IN", type: "PTT", author: { type: "CONTACT", uuid: "c" }, components: { attachments: [{ type: "AUDIO" }] } }))!;
    expect(e.body).toBe("[PTT]");
  });

  it("payload sem atendimento, contato, id ou horário é ignorado", () => {
    expect(parsePoliEvent(payload({ attendance: null }))).toBeNull();
    expect(parsePoliEvent(payload({ contact: null }))).toBeNull();
    expect(parsePoliEvent(payload({ uuid: null }))).toBeNull();
    expect(parsePoliEvent(payload({ timestamp: "x" }))).toBeNull();
    expect(parsePoliEvent({ object: "contact" })).toBeNull();
  });
});

describe("toE164", () => {
  it.each([
    ["5511999990000", "+5511999990000"],
    ["11999990000", "+5511999990000"],
    ["+55 (11) 99999-0000", "+5511999990000"],
    ["", null],
    [null, null],
  ])("%s → %s", (input, out) => expect(toE164(input)).toBe(out));
});
