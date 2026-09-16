import { describe, expect, it } from "vitest";
import { isPreSalesAttendant } from "../src/config/team.js";

describe("isPreSalesAttendant", () => {
  it("reconhece e-mail da whitelist (case-insensitive)", () => {
    expect(isPreSalesAttendant("sdr1@poli.digital")).toBe(true);
    expect(isPreSalesAttendant("SDR2@Poli.Digital")).toBe(true);
  });

  it("rejeita e-mail fora da whitelist", () => {
    expect(isPreSalesAttendant("suporte@poli.digital")).toBe(false);
  });

  it("rejeita valores vazios/indefinidos", () => {
    expect(isPreSalesAttendant(undefined)).toBe(false);
    expect(isPreSalesAttendant(null)).toBe(false);
    expect(isPreSalesAttendant("")).toBe(false);
  });
});
