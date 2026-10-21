import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";

// Limites baixos pra exercitar no teste — definidos antes do import dinâmico,
// que é quando a config é lida.
process.env.WEBHOOK_RATE_LIMIT_PER_MINUTE = "3";
process.env.WEBHOOK_MAX_BODY = "1kb";

const { clientIp, createRateLimiter, createRejectionMonitor, rateLimitGuard, contentTypeGuard, bodyErrorGuard } =
  await import("../src/webhookGuard.js");
const { logger } = await import("../src/logger.js");

describe("createRateLimiter", () => {
  it("recusa acima do limite por minuto e libera na janela seguinte", () => {
    let t = 0;
    const allow = createRateLimiter(2, () => t);
    expect([allow("1.1.1.1"), allow("1.1.1.1"), allow("1.1.1.1")]).toEqual([true, true, false]);
    expect(allow("2.2.2.2")).toBe(true);
    t = 60_000;
    expect(allow("1.1.1.1")).toBe(true);
  });
});

describe("createRejectionMonitor", () => {
  it("alerta ao atingir o limite e não repete dentro da mesma janela", () => {
    let t = 0;
    const onAlert = vi.fn();
    const record = createRejectionMonitor(3, 10_000, onAlert, () => t);
    record("rate_limited");
    record("rate_limited");
    expect(onAlert).not.toHaveBeenCalled();
    record("invalid_signature");
    expect(onAlert).toHaveBeenCalledWith(3, { rate_limited: 2, invalid_signature: 1 });
    record("rate_limited");
    expect(onAlert).toHaveBeenCalledTimes(1);
    t = 10_000;
    record("rate_limited");
    record("rate_limited");
    record("rate_limited");
    expect(onAlert).toHaveBeenCalledTimes(2);
  });

  it("recusas antigas saem da conta", () => {
    let t = 0;
    const onAlert = vi.fn();
    const record = createRejectionMonitor(2, 10_000, onAlert, () => t);
    record("invalid_json");
    t = 10_001;
    record("invalid_json");
    expect(onAlert).not.toHaveBeenCalled();
  });
});

describe("clientIp", () => {
  it("usa o primeiro valor do X-Forwarded-For", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const req = { headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.2" }, socket: { remoteAddress: "10.0.0.2" } } as any;
    expect(clientIp(req)).toBe("203.0.113.7");
  });

  it("cai pro IP da conexão sem o header", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const req = { headers: {}, socket: { remoteAddress: "10.0.0.2" } } as any;
    expect(clientIp(req)).toBe("10.0.0.2");
  });
});

describe("cadeia do webhook (HTTP)", () => {
  const handler = vi.fn((_req: express.Request, res: express.Response) => res.status(200).json({ received: true }));
  let baseUrl = "";
  let server: ReturnType<express.Express["listen"]>;
  let ipCounter = 0;

  beforeAll(async () => {
    const app = express();
    app.post("/", rateLimitGuard, contentTypeGuard, express.json({ limit: "1kb" }), bodyErrorGuard, handler);
    await new Promise<void>((resolve) => {
      server = app.listen(0, resolve);
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });

  afterAll(() => server.close());

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // IP novo por teste, pra o limite de um não vazar no outro.
  const post = (body: string, headers: Record<string, string> = {}, ip = `198.51.100.${++ipCounter}`) =>
    fetch(baseUrl, { method: "POST", body, headers: { "content-type": "application/json", "x-forwarded-for": ip, ...headers } });

  it("aceita JSON dentro do limite", async () => {
    const res = await post(JSON.stringify({ ok: true }));
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("responde 429 acima do limite por IP, sem chegar no handler", async () => {
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await post("{}", {}, "192.0.2.50")).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
    expect(handler).toHaveBeenCalledTimes(3);
    // Outro IP segue passando.
    expect((await post("{}", {}, "192.0.2.51")).status).toBe(200);
  });

  it("recusa Content-Type que não é JSON", async () => {
    const res = await post("telefone=5511999999999", { "content-type": "application/x-www-form-urlencoded" });
    expect(res.status).toBe(415);
    expect(handler).not.toHaveBeenCalled();
  });

  it("recusa corpo acima do limite", async () => {
    const res = await post(JSON.stringify({ text: "x".repeat(2000) }));
    expect(res.status).toBe(413);
    expect(handler).not.toHaveBeenCalled();
  });

  it("recusa JSON quebrado sem levar o conteúdo pro log", async () => {
    const warn = vi.spyOn(logger, "warn");
    const res = await post('{"phone":"5511988887777", oi');
    expect(res.status).toBe(400);
    expect(handler).not.toHaveBeenCalled();
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain("invalid_json");
    expect(logged).not.toContain("5511988887777");
    warn.mockRestore();
  });
});
