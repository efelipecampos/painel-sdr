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

  it("não grava evento que não é de mensagem", async () => {
    const result = await captureRawEvent(
      { object: "contact", event: "updated", uuid: "evt-contato" },
      "contacts.contact.updated",
      store.deps,
    );

    expect(result).toMatchObject({ capture: false, reason: "nao_e_mensagem" });
    expect(store.rows).toHaveLength(0);
  });

  it("não grava ACK de entrega/leitura nem atualização de mensagem", async () => {
    for (const event of ["ack", "updated"]) {
      const result = await captureRawEvent(evento({ event, ownerEmail: SDR }), undefined, store.deps);
      expect(result, event).toMatchObject({ capture: false, reason: "ack_ou_atualizacao" });
    }
    expect(store.rows).toHaveLength(0);
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
