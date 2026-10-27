import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureRawEvent, type CaptureDeps } from "../src/pipeline/captureRawEvent.js";
import type { RawEventBody } from "../src/poli/rawEventFilter.js";

/**
 * Os e-mails de equipe vêm de tests/setupEnv.ts (POLI_SDR_EMAILS /
 * POLI_CLOSER_EMAILS), e POLI_APP_TOKEN_AUTHORLESS_TEMPLATES está ligado lá
 * pra cobrir a regra do app token.
 */
const SDR = "sdr1@poli.digital";
const CLOSER = "closer1@poli.digital";
const FORA_DA_EQUIPE = "suporte.fulano@poli.digital";

const ATENDIMENTO = "f2c48d77-ae1a-11f1-9d75-06799772b1cd";

interface FakeStore {
  rows: Array<{ source: string; external_id: string }>;
  attendances: Set<string>;
  queue: Array<{ externalId: string; error: string }>;
  deps: CaptureDeps;
  failNext: boolean;
}

function fakeStore(): FakeStore {
  const store: FakeStore = {
    rows: [],
    attendances: new Set<string>(),
    queue: [],
    failNext: false,
    deps: {} as CaptureDeps,
  };
  store.deps = {
    insert: async (row) => {
      if (store.failNext) throw new Error("supabase fora do ar");
      // Chave única (source, external_id): reentrega não duplica.
      const exists = store.rows.some((r) => r.source === row.source && r.external_id === row.external_id);
      if (!exists) store.rows.push({ source: row.source, external_id: row.external_id });
    },
    attendanceCaptured: async (uuid) => store.attendances.has(uuid),
    markAttendance: (uuid) => store.attendances.add(uuid),
    messageCaptured: async (uuid) => store.rows.some((r) => r.external_id === uuid),
    enqueueFailure: (externalId, _eventType, _payload, error) => store.queue.push({ externalId, error }),
    clearJob: () => {},
  };
  return store;
}

interface EventOptions {
  uuid?: string;
  event?: string;
  direction?: string;
  type?: string;
  ownerEmail?: string | null;
  author?: { type?: string; uuid?: string } | null;
  template?: object | null;
  attendanceUuid?: string | null;
}

function evento(options: EventOptions = {}): RawEventBody {
  const uuid = options.uuid ?? "evt-1";
  return {
    object: "message",
    event: options.event ?? "received",
    uuid,
    value: {
      uuid,
      type: options.type ?? "CHAT",
      direction: options.direction ?? "IN",
      template: options.template ?? null,
      author: options.author === undefined ? { type: "CONTACT", uuid: "autor-1" } : options.author,
      attendance:
        options.attendanceUuid === null
          ? null
          : {
              uuid: options.attendanceUuid ?? ATENDIMENTO,
              attendant: options.ownerEmail === null ? null : { email: options.ownerEmail ?? SDR },
            },
    },
  };
}

describe("captureRawEvent — filtro da equipe de pré-vendas", () => {
  let store: FakeStore;

  beforeEach(() => {
    store = fakeStore();
  });

  it("grava mensagem do lead em chat com dono SDR", async () => {
    const result = await captureRawEvent(evento({ ownerEmail: SDR }), undefined, store.deps);

    expect(result).toMatchObject({ capture: true, reason: "dono_da_equipe", stored: true });
    expect(store.rows).toHaveLength(1);
  });

  it("grava mensagem enviada pelo próprio SDR", async () => {
    const result = await captureRawEvent(
      evento({ event: "sent", direction: "OUT", ownerEmail: SDR, author: { type: "USER", uuid: "user-sdr" } }),
      undefined,
      store.deps,
    );

    expect(result).toMatchObject({ capture: true, reason: "dono_da_equipe", stored: true });
  });

  it("grava mensagem em chat com dono closer", async () => {
    const result = await captureRawEvent(evento({ ownerEmail: CLOSER }), undefined, store.deps);

    expect(result).toMatchObject({ capture: true, reason: "dono_da_equipe", stored: true });
  });

  it("não grava mensagem em chat com dono fora da equipe", async () => {
    const result = await captureRawEvent(evento({ ownerEmail: FORA_DA_EQUIPE }), undefined, store.deps);

    expect(result).toMatchObject({ capture: false, reason: "fora_da_equipe" });
    expect(store.rows).toHaveLength(0);
  });

  it("grava template do bot enviado pelo app token, mesmo sem dono da equipe", async () => {
    const result = await captureRawEvent(
      evento({
        event: "sent",
        direction: "OUT",
        ownerEmail: FORA_DA_EQUIPE,
        author: { type: "USER" },
        template: { key: "aberturademilhao" },
      }),
      undefined,
      store.deps,
    );

    expect(result).toMatchObject({ capture: true, reason: "app_token", stored: true });
  });

  it("não confunde template enviado por humano (autor com uuid) com o app token", async () => {
    const result = await captureRawEvent(
      evento({
        event: "sent",
        direction: "OUT",
        ownerEmail: FORA_DA_EQUIPE,
        author: { type: "USER", uuid: "user-humano" },
        template: { key: "aberturademilhao" },
      }),
      undefined,
      store.deps,
    );

    expect(result).toMatchObject({ capture: false, reason: "fora_da_equipe" });
  });

  it("grava evento SYSTEM que tira o chat da equipe quando o atendimento já tem evento gravado", async () => {
    await captureRawEvent(evento({ uuid: "evt-inicial", ownerEmail: SDR }), undefined, store.deps);

    const saida = evento({
      uuid: "evt-system",
      direction: "SYSTEM",
      type: "ATTENDANCE_REDIRECTED",
      ownerEmail: FORA_DA_EQUIPE,
      author: { type: "USER", uuid: "user-1" },
    });
    const result = await captureRawEvent(saida, undefined, store.deps);

    expect(result).toMatchObject({ capture: true, reason: "saida_do_chat_da_equipe", stored: true });
    expect(store.rows).toHaveLength(2);
  });

  it("não grava evento SYSTEM de atendimento desconhecido", async () => {
    const result = await captureRawEvent(
      evento({
        uuid: "evt-system-2",
        direction: "SYSTEM",
        type: "ATTENDANCE_REDIRECTED",
        ownerEmail: FORA_DA_EQUIPE,
        attendanceUuid: "atendimento-nunca-visto",
      }),
      undefined,
      store.deps,
    );

    expect(result).toMatchObject({ capture: false });
    expect(store.rows).toHaveLength(0);
  });

  it("não grava contato atualizado nem objeto desconhecido", async () => {
    const atualizado = await captureRawEvent({ object: "contact", event: "updated", uuid: "c-1" }, "contacts.contact.updated", store.deps);
    const outro = await captureRawEvent({ object: "chat", event: "created", uuid: "x-1" }, undefined, store.deps);

    expect(atualizado).toMatchObject({ capture: false, reason: "contato_atualizado" });
    expect(outro).toMatchObject({ capture: false, reason: "nao_e_mensagem" });
    expect(store.rows).toHaveLength(0);
  });

  it("grava ACK só de mensagem já gravada (da equipe), e não a atualização de mensagem", async () => {
    await captureRawEvent(evento({ uuid: "msg-sdr", ownerEmail: SDR }), undefined, store.deps);
    const ack = { object: "message", event: "ack", uuid: "msg-sdr", status: "READ_BY_CLIENT" };
    const deFora = { object: "message", event: "ack", uuid: "msg-suporte", status: "READ_BY_CLIENT" };

    expect(await captureRawEvent(ack, "messages.message.ack", store.deps)).toMatchObject({ capture: true, reason: "ack", stored: true });
    expect(await captureRawEvent(deFora, "messages.message.ack", store.deps)).toMatchObject({ capture: false, reason: "fora_da_equipe" });
    expect(await captureRawEvent(evento({ event: "updated", ownerEmail: SDR }), undefined, store.deps)).toMatchObject({ capture: false, reason: "ack_ou_atualizacao" });
    expect(store.rows).toHaveLength(2);
  });

  it("vários ACKs da mesma mensagem viram linhas diferentes (o uuid é da mensagem)", async () => {
    await captureRawEvent(evento({ uuid: "msg-1", ownerEmail: SDR }), undefined, store.deps);
    for (const status of ["RECEIVED_BY_PROVIDER", "RECEIVED_BY_CLIENT", "READ_BY_CLIENT"]) {
      await captureRawEvent({ object: "message", event: "ack", uuid: "msg-1", status } as RawEventBody, "messages.message.ack", store.deps);
    }
    expect(store.rows).toHaveLength(4);
  });

  it("atendimento: grava o da equipe e o fechamento de atendimento já conhecido; ignora o de fora", async () => {
    const daEquipe = { object: "attendance", event: "created", uuid: "a-1", value: { uuid: "a-1", attendant: { email: SDR } } };
    const fechadoPorFora = { object: "attendance", event: "closed", uuid: "a-1", value: { uuid: "a-1", attendant: { email: FORA_DA_EQUIPE } } };
    const deFora = { object: "attendance", event: "created", uuid: "a-9", value: { uuid: "a-9", attendant: { email: FORA_DA_EQUIPE } } };

    expect(await captureRawEvent(daEquipe, "attendances.attendance.created", store.deps)).toMatchObject({ capture: true, reason: "atendimento" });
    expect(await captureRawEvent(fechadoPorFora, "attendances.attendance.closed", store.deps)).toMatchObject({ capture: true, reason: "atendimento" });
    expect(await captureRawEvent(deFora, "attendances.attendance.created", store.deps)).toMatchObject({ capture: false, reason: "fora_da_equipe" });
    expect(store.rows).toHaveLength(2);
  });

  it("contato: grava criado e tag com atendimento da equipe; ignora sem dono, atualizado e encaminhado", async () => {
    const comSdr = (event: string) => ({ object: "contact", event, uuid: "c-1", value: { current_attendance: { uuid: "a-2", attendant: { email: SDR } } } });

    expect(await captureRawEvent(comSdr("created"), "contacts.contact.created", store.deps)).toMatchObject({ capture: true, reason: "contato" });
    expect(await captureRawEvent(comSdr("tag_attached"), "contacts.contact.tag_attached", store.deps)).toMatchObject({ capture: true, reason: "contato" });
    expect(await captureRawEvent({ object: "contact", event: "created", uuid: "c-2", value: { current_attendance: null } }, undefined, store.deps)).toMatchObject({ capture: false });
    expect(await captureRawEvent(comSdr("updated"), "contacts.contact.updated", store.deps)).toMatchObject({ capture: false, reason: "contato_atualizado" });
    expect(await captureRawEvent(comSdr("forwarded"), "contacts.contact.forwarded", store.deps)).toMatchObject({ capture: false, reason: "contato_atualizado" });
    expect(store.rows).toHaveLength(2);
  });

  it("tag no contato: grava só a tag de descarte vinculada; ignora outras tags e a remoção", async () => {
    const tag = (event: string, name: string) => ({
      object: "contact", event, uuid: "c-1",
      value: { contact: { uuid: "c-1" }, tag: { uuid: "t-1", attributes: { name } }, timestamp: "2026-10-27T15:00:00Z" },
    });
    expect(await captureRawEvent(tag("tag_linked", "Descarte - Sem CNPJ"), "contacts.contact.tag_linked", store.deps)).toMatchObject({ capture: true, reason: "tag_descarte" });
    expect(await captureRawEvent(tag("tag_linked", "Cliente Atendido"), "contacts.contact.tag_linked", store.deps)).toMatchObject({ capture: false, reason: "tag_fora_do_descarte" });
    expect(await captureRawEvent(tag("tag_unlinked", "Descarte - Sem CNPJ"), "contacts.contact.tag_unlinked", store.deps)).toMatchObject({ capture: false, reason: "tag_fora_do_descarte" });
    expect(store.rows).toHaveLength(1);
  });

  it("evento igual: reentrega não duplica, mas repetido 10 min depois entra", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-23T15:00:00Z"));
      const corpo = { object: "attendance", event: "updated", uuid: "a-1", value: { uuid: "a-1", attendant: { email: SDR } } };
      await captureRawEvent(corpo, "attendances.attendance.updated", store.deps);
      await captureRawEvent(corpo, "attendances.attendance.updated", store.deps);
      expect(store.rows).toHaveLength(1);

      vi.setSystemTime(new Date("2026-10-23T15:10:00Z"));
      await captureRawEvent(corpo, "attendances.attendance.updated", store.deps);
      expect(store.rows).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reentrega do mesmo evento não duplica", async () => {
    const mesmo = evento({ uuid: "evt-repetido", ownerEmail: SDR });

    await captureRawEvent(mesmo, undefined, store.deps);
    await captureRawEvent(mesmo, undefined, store.deps);

    expect(store.rows).toHaveLength(1);
  });

  it("falha no Supabase não lança: enfileira pro retry", async () => {
    store.failNext = true;

    const result = await captureRawEvent(evento({ uuid: "evt-falha", ownerEmail: SDR }), undefined, store.deps);

    expect(result).toMatchObject({ capture: true, stored: false, queued: true });
    expect(store.queue).toEqual([{ externalId: "evt-falha", error: "supabase fora do ar" }]);
    expect(store.rows).toHaveLength(0);
  });

  it("usa o header x-webhook-event como event_type quando existe", async () => {
    const insert = vi.fn(async () => {});

    await captureRawEvent(evento({ ownerEmail: SDR }), "messages.message.received", { ...store.deps, insert });

    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ source: "poli_webhook", event_type: "messages.message.received" }),
    );
  });
});
