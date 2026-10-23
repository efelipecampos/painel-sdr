import { describe, expect, it } from "vitest";
import { getAttendantRole } from "../src/config/team.js";

describe("getAttendantRole", () => {
  it("reconhece e-mail de SDR (case-insensitive)", () => {
    expect(getAttendantRole("sdr1@poli.digital")).toBe("SDR");
    expect(getAttendantRole("SDR1@Poli.Digital")).toBe("SDR");
  });

  it("reconhece e-mail de Closer (case-insensitive)", () => {
    expect(getAttendantRole("closer1@poli.digital")).toBe("CLOSER");
    expect(getAttendantRole("CLOSER1@Poli.Digital")).toBe("CLOSER");
  });

  it("retorna null pra e-mail fora das duas listas", () => {
    expect(getAttendantRole("suporte@poli.digital")).toBeNull();
  });

  it("retorna null pra valores vazios/indefinidos", () => {
    expect(getAttendantRole(undefined)).toBeNull();
    expect(getAttendantRole(null)).toBeNull();
    expect(getAttendantRole("")).toBeNull();
  });
});
