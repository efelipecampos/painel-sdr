import { beforeEach, describe, expect, it, vi } from "vitest";
import received from "./fixtures/received.json" with { type: "json" };

/**
 * Garante o isolamento entre a gravação do evento cru e o fluxo existente:
 * mesmo com o Supabase fora do ar, a Poli continua recebendo 200 e a mensagem
 * segue para o HubSpot.
 */

vi.mock("../src/poli/webhookAuth.js", () => ({ verifyPoliSignature: () => true }));
vi.mock("../src/pipeline/processMessage.js", () => ({
  processMessage: vi.fn(async () => ({ outcome: "logged", contactId: "1", communicationId: "2", dealIds: [] })),
}));
vi.mock("../src/supabase/client.js", () => ({
  isSupabaseConfigured: () => true,
  supabaseFetch: vi.fn(),
}));
vi.mock("../src/supabase/rawEvents.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/supabase/rawEvents.js")>();
  return {
    ...original,
    insertRawEvent: vi.fn(async () => {
      throw new Error("supabase fora do ar");
    }),
    attendanceHasRawEvent: vi.fn(async () => false),
  };
});

// O atendente do fixture precisa contar como equipe pro evento ser gravado —
// definido antes dos imports dinâmicos, que é quando a config é lida.
process.env.POLI_SDR_EMAILS = "sdr1@poli.digital,julliana.reis@poli.digital";

const { webhookHandler } = await import("../src/webhookHandler.js");
const { processMessage } = await import("../src/pipeline/processMessage.js");
const { insertRawEvent } = await import("../src/supabase/rawEvents.js");

function fakeReqRes(body: unknown) {
  const res = {
    statusCode: 0,
    payload: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(value: unknown) {
      this.payload = value;
      return this;
    },
  };
  const req = {
    body,
    headers: { "x-webhook-event": "messages.message.received" },
    rawBody: Buffer.from(JSON.stringify(body)),
    log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
  };
  return { req, res };
}

describe("webhook: falha ao gravar evento cru", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("mantém a resposta 200 e o processamento no HubSpot", async () => {
    const { req, res } = fakeReqRes(received);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await webhookHandler(req as any, res as any);
    await vi.waitFor(() => expect(insertRawEvent).toHaveBeenCalled());

    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({ received: true });
    expect(processMessage).toHaveBeenCalledTimes(1);
  });
});
