import { describe, expect, it } from "vitest";
import { clientIp, LoginLimiter } from "./login-limit";

const MIN = 60_000;

describe("limite de tentativas de login", () => {
  it("bloqueia o e-mail na 6ª tentativa errada em 15 min e libera depois", () => {
    const l = new LoginLimiter();
    for (let i = 0; i < 5; i++) {
      expect(l.blockedFor("Ana@poli.digital", "1.1.1.1", i * MIN)).toBe(0);
      l.fail("ana@poli.digital", "1.1.1.1", i * MIN);
    }
    expect(l.blockedFor("ana@poli.digital", "2.2.2.2", 5 * MIN)).toBe(10); // a 1ª falha (minuto 0) sai aos 15
    expect(l.blockedFor("ana@poli.digital", "2.2.2.2", 15 * MIN)).toBe(0);
  });
  it("outro e-mail no mesmo IP continua podendo, até o limite do IP", () => {
    const l = new LoginLimiter();
    for (let i = 0; i < 5; i++) l.fail("ana@x", "9.9.9.9", 0);
    expect(l.blockedFor("bia@x", "9.9.9.9", 0)).toBe(0);
    for (let i = 0; i < 15; i++) l.fail(`robo${i}@x`, "9.9.9.9", 0);
    expect(l.blockedFor("bia@x", "9.9.9.9", 0)).toBe(15);
    expect(l.blockedFor("bia@x", "8.8.8.8", 0)).toBe(0);
  });
  it("login certo limpa as falhas do e-mail", () => {
    const l = new LoginLimiter();
    for (let i = 0; i < 4; i++) l.fail("ana@x", "1.1.1.1", 0);
    l.success("ana@x");
    for (let i = 0; i < 4; i++) l.fail("ana@x", "1.1.1.1", 0);
    expect(l.blockedFor("ana@x", "3.3.3.3", 0)).toBe(0);
  });
  it("IP: primeiro do X-Forwarded-For", () => {
    expect(clientIp("200.1.2.3, 10.0.0.1", null)).toBe("200.1.2.3");
    expect(clientIp(null, "10.0.0.5")).toBe("10.0.0.5");
    expect(clientIp(null, null)).toBe("desconhecido");
  });
});
