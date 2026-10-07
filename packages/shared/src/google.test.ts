import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { GoogleCalendar, GoogleError, accessToken, authUrl, decryptToken, encryptToken, eventState, exchangeCode, isFree } from "./google";

const KEY = randomBytes(32).toString("base64");
const creds = { clientId: "cid", clientSecret: "sec", redirectUri: "https://x/api/google/callback" };
const t = (h: string) => new Date(`2026-10-12T${h}:00-03:00`);
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const idToken = (p: object) => `x.${Buffer.from(JSON.stringify(p)).toString("base64url")}.y`;

describe("cifra do token", () => {
  it("ida e volta; não guarda o texto aberto; chave errada ou texto adulterado falham", () => {
    const enc = encryptToken("1//refresh-abc", KEY);
    expect(enc).not.toContain("refresh");
    expect(decryptToken(enc, KEY)).toBe("1//refresh-abc");
    expect(encryptToken("1//refresh-abc", KEY)).not.toBe(enc); // IV aleatório
    expect(() => decryptToken(enc, randomBytes(32).toString("base64"))).toThrow();
    const raw = Buffer.from(enc.slice(3), "base64");
    raw[raw.length - 1] ^= 1;
    expect(() => decryptToken(`v1:${raw.toString("base64")}`, KEY)).toThrow();
    expect(() => encryptToken("x", Buffer.from("curta").toString("base64"))).toThrow(/32 bytes/);
  });
});

describe("conexão", () => {
  it("URL pede só as permissões mínimas, offline, no domínio poli.digital", () => {
    const u = new URL(authUrl(creds, "st", "ana@poli.digital"));
    expect(u.searchParams.get("scope")).toBe("openid email https://www.googleapis.com/auth/calendar.freebusy https://www.googleapis.com/auth/calendar.events");
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("hd")).toBe("poli.digital");
    expect(u.searchParams.get("state")).toBe("st");
  });

  it("troca o código e lê o e-mail; recusa permissão faltando ou sem refresh_token", async () => {
    const ok = { refresh_token: "r1", scope: "openid email https://www.googleapis.com/auth/calendar.freebusy https://www.googleapis.com/auth/calendar.events", id_token: idToken({ email: "Ana@Poli.Digital", email_verified: true }) };
    expect(await exchangeCode(creds, "c", async () => json(200, ok))).toMatchObject({ refreshToken: "r1", email: "ana@poli.digital" });
    await expect(exchangeCode(creds, "c", async () => json(200, { ...ok, scope: "openid email https://www.googleapis.com/auth/calendar.freebusy" }))).rejects.toThrow(/permissao_faltando/);
    await expect(exchangeCode(creds, "c", async () => json(200, { ...ok, refresh_token: undefined }))).rejects.toThrow(/sem_refresh_token/);
  });

  it("autorização revogada vira GoogleError.revoked", async () => {
    const e = await accessToken(creds, "r", async () => json(400, { error: "invalid_grant" })).catch((x) => x);
    expect(e).toBeInstanceOf(GoogleError);
    expect(e.revoked).toBe(true);
  });
});

describe("livre e ocupado", () => {
  const busy = [{ start: t("10:00"), end: t("11:00") }];
  it("conflito direto e dentro do intervalo de 15 min", () => {
    expect(isFree(busy, t("10:30"), t("11:00"), 15)).toBe(false);
    expect(isFree(busy, t("11:10"), t("11:40"), 15)).toBe(false);
    expect(isFree(busy, t("09:20"), t("09:50"), 15)).toBe(false);
  });
  it("encostado no limite do intervalo está livre", () => {
    expect(isFree(busy, t("11:15"), t("11:45"), 15)).toBe(true);
    expect(isFree(busy, t("09:15"), t("09:45"), 15)).toBe(true);
    expect(isFree([], t("10:00"), t("10:30"), 15)).toBe(true);
  });
  it("lê o livre/ocupado e trata agenda com erro como falha (não como livre)", async () => {
    const cal = new GoogleCalendar("tk", async () => json(200, { calendars: { primary: { busy: [{ start: "2026-10-12T13:00:00Z", end: "2026-10-12T14:00:00Z" }] } } }));
    expect(await cal.busy(t("07:00"), t("20:00"))).toEqual([{ start: new Date("2026-10-12T13:00:00Z"), end: new Date("2026-10-12T14:00:00Z") }]);
    const bad = new GoogleCalendar("tk", async () => json(200, { calendars: { primary: { errors: [{ reason: "notFound" }] } } }));
    await expect(bad.busy(t("07:00"), t("20:00"))).rejects.toThrow(/notFound/);
  });
});

describe("situação do evento", () => {
  const ev = (att: object[], status = "confirmed") => ({ id: "e", status, attendees: att as never });
  it("apagado, recusado pelo lead, recusado pelo closer, ok", () => {
    expect(eventState(null, "l@x.com")).toBe("removida");
    expect(eventState(ev([], "cancelled"), null)).toBe("removida");
    expect(eventState(ev([{ email: "L@X.com", responseStatus: "declined" }]), "l@x.com")).toBe("recusada_lead");
    expect(eventState(ev([{ email: "c@poli.digital", self: true, organizer: true, responseStatus: "declined" }]), "l@x.com")).toBe("recusada_closer");
    expect(eventState(ev([{ email: "l@x.com", responseStatus: "needsAction" }]), "l@x.com")).toBe("ok");
    // sem e-mail do lead: convidado de fora da Poli que recusou; SDR (poli.digital) recusando não conta
    expect(eventState(ev([{ email: "l@x.com", responseStatus: "declined" }]), null)).toBe("recusada_lead");
    expect(eventState(ev([{ email: "sdr@poli.digital", responseStatus: "declined" }]), null)).toBe("ok");
  });
  it("leitura de evento apagado devolve null (410 ou status cancelled); apagar de novo não é erro", async () => {
    expect(await new GoogleCalendar("tk", async () => json(410, { error: { errors: [{ reason: "deleted" }] } })).get("e")).toBeNull();
    expect(await new GoogleCalendar("tk", async () => json(200, { id: "e", status: "cancelled" })).get("e")).toBeNull();
    await expect(new GoogleCalendar("tk", async () => json(410, { error: { errors: [{ reason: "deleted" }] } })).remove("e")).resolves.toBeUndefined();
  });
});
