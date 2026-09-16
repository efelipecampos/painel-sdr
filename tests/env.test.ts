import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("env: POLI_WEBHOOK_VERIFY_SIGNATURE", () => {
  const original = process.env.POLI_WEBHOOK_VERIFY_SIGNATURE;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env.POLI_WEBHOOK_VERIFY_SIGNATURE = original;
  });

  it('interpreta a string "false" como false (não como Boolean("false") = true)', async () => {
    process.env.POLI_WEBHOOK_VERIFY_SIGNATURE = "false";
    const { env } = await import("../src/config/env.js");
    expect(env.POLI_WEBHOOK_VERIFY_SIGNATURE).toBe(false);
  });

  it('interpreta a string "true" como true', async () => {
    process.env.POLI_WEBHOOK_VERIFY_SIGNATURE = "true";
    const { env } = await import("../src/config/env.js");
    expect(env.POLI_WEBHOOK_VERIFY_SIGNATURE).toBe(true);
  });
});
