import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { GoogleCalendar, GoogleError, accessToken, activeTitle, archiveTitle, authUrl, decryptToken, encryptToken, eventState, exchangeCode, isFree, isFreeOcupado } from "./google";

const KEY = randomBytes(32).toString("base64");
const creds = { clientId: "cid", clientSecret: "sec", redirectUri: "https://x/api/google/callback" };
const t = (h: string) => new Date(`2026-10-12T${h}:00-03:00`);
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const INTERNOS = ["poli.digital", "chatshub.com.br"];
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
  it("intervalo do carrossel só entre reuniões do painel; ocupado do Google bloqueia sem intervalo", () => {
    const almoco = { start: t("12:00"), end: t("13:00") };
    // almoço às 12:00 libera 11:00–12:00 (60 min, intervalo 15)
    expect(isFreeOcupado({ google: [almoco], cliente: [] }, t("11:00"), t("12:00"), 15)).toBe(true);
    expect(isFreeOcupado({ google: [almoco], cliente: [] }, t("13:00"), t("14:00"), 15)).toBe(true);
    // mas continua bloqueando o próprio horário
    expect(isFreeOcupado({ google: [almoco], cliente: [] }, t("11:30"), t("12:30"), 15)).toBe(false);
    // reunião do painel às 12:00 (que também aparece no Google) não libera 11:00–12:00
    const reuniao = { start: t("12:00"), end: t("13:00") };
    expect(isFreeOcupado({ google: [reuniao], cliente: [reuniao] }, t("11:00"), t("12:00"), 15)).toBe(false);
    expect(isFreeOcupado({ google: [reuniao], cliente: [reuniao] }, t("10:45"), t("11:45"), 15)).toBe(true);
    expect(isFreeOcupado({ google: [reuniao], cliente: [reuniao] }, t("13:00"), t("14:00"), 15)).toBe(false);
    expect(isFreeOcupado({ google: [reuniao], cliente: [reuniao] }, t("13:15"), t("14:15"), 15)).toBe(true);
  });
  it("intervalo de 30 min antes e depois de reunião do painel", () => {
    const r = { start: t("10:00"), end: t("11:00") };
    const o = { google: [r], cliente: [r] };
    expect(isFreeOcupado(o, t("11:00"), t("12:00"), 30)).toBe(false);  // logo depois
    expect(isFreeOcupado(o, t("11:30"), t("12:30"), 30)).toBe(true);   // meia hora depois
    expect(isFreeOcupado(o, t("09:00"), t("10:00"), 30)).toBe(false);  // termina logo antes
    expect(isFreeOcupado(o, t("08:45"), t("09:45"), 30)).toBe(false);  // só 15 min antes
    expect(isFreeOcupado(o, t("08:30"), t("09:30"), 30)).toBe(true);   // meia hora antes
  });
  it("Google pediu para esperar (403 rateLimitExceeded, 429, 5xx): tenta de novo 1 s, 2 s, 4 s", async () => {
    const esperas: number[] = [];
    let n = 0;
    const cal = new GoogleCalendar("tk", async () => (++n < 3 ? json(403, { error: { errors: [{ reason: "rateLimitExceeded" }] } }) : json(200, { id: "ev1", status: "confirmed" })),
      async (ms) => { esperas.push(ms); });
    expect((await cal.patch("ev1", { title: "x" }, "primary", false)).id).toBe("ev1");
    expect(esperas).toEqual([1000, 2000]);
    const sempre = new GoogleCalendar("tk", async () => json(503, {}), async () => {});
    await expect(sempre.patch("ev1", { title: "x" })).rejects.toThrow(/503/);
  });
  it("403 de permissão (forbidden) não é repetido", async () => {
    let n = 0;
    const cal = new GoogleCalendar("tk", async () => { n++; return json(403, { error: { errors: [{ reason: "forbidden" }] } }); }, async () => {});
    await expect(cal.patch("ev1", { title: "x" })).rejects.toThrow(/forbidden/);
    expect(n).toBe(1);
  });
  it("lê o livre/ocupado e trata agenda com erro como falha (não como livre)", async () => {
    const cal = new GoogleCalendar("tk", async () => json(200, { calendars: { primary: { busy: [{ start: "2026-10-12T13:00:00Z", end: "2026-10-12T14:00:00Z" }] } } }));
    expect(await cal.busy(t("07:00"), t("20:00"))).toEqual([{ start: new Date("2026-10-12T13:00:00Z"), end: new Date("2026-10-12T14:00:00Z") }]);
    const bad = new GoogleCalendar("tk", async () => json(200, { calendars: { primary: { errors: [{ reason: "notFound" }] } } }));
    await expect(bad.busy(t("07:00"), t("20:00"))).rejects.toThrow(/notFound/);
  });
  it("lê os eventos: a própria reunião não ocupa; evento disponível, recusado ou cancelado também não", async () => {
    const ev = (id: string, s: string, e: string, extra: object = {}) => ({ id, start: { dateTime: t(s).toISOString() }, end: { dateTime: t(e).toISOString() }, ...extra });
    const urls: string[] = [];
    const pages: Record<string, unknown> = {
      "": { items: [ev("propria", "16:00", "17:00"), ev("livre", "16:30", "17:30", { transparency: "transparent" })], nextPageToken: "p2" },
      p2: { items: [ev("recusada", "16:30", "17:00", { attendees: [{ self: true, responseStatus: "declined" }] }), ev("cancelada", "16:30", "17:00", { status: "cancelled" }), ev("outra", "17:30", "18:00")] },
    };
    const cal = new GoogleCalendar("tk", async (u) => {
      urls.push(String(u));
      return json(200, pages[new URL(String(u)).searchParams.get("pageToken") ?? ""]);
    });
    const o = await cal.ocupados(t("00:00"), t("23:59"), { internos: INTERNOS, excetoEvento: "propria" });
    expect(o).toEqual({ google: [{ start: t("17:30"), end: t("18:00") }], cliente: [] });
    // mudar de 16:00 para 16:30 com o mesmo closer: livre (o compromisso das 17:30 não tem cliente, sem intervalo)
    expect(isFreeOcupado(o, t("16:30"), t("17:30"), 30)).toBe(true);
    // só pede horário, situação e convidados (nada de título nem descrição)
    expect(new URL(urls[0]).searchParams.get("fields")).not.toMatch(/summary|description/);
    expect(urls).toHaveLength(2);
  });
  it("reunião com cliente marcada fora do painel (convidado de fora da empresa) ganha o intervalo; almoço e reunião interna não", async () => {
    const ev = (id: string, s: string, e: string, emails: string[]) => ({
      id, start: { dateTime: t(s).toISOString() }, end: { dateTime: t(e).toISOString() },
      attendees: [{ email: "closer@poli.digital", self: true }, ...emails.map((email) => ({ email }))],
    });
    const cal = new GoogleCalendar("tk", async () => json(200, { items: [
      ev("almoco", "12:00", "13:00", []),
      ev("interna", "10:00", "11:00", ["gestor@poli.digital", "ana@CHATSHUB.com.br"]),
      ev("cliente", "14:00", "15:00", ["closer2@poli.digital", "contato@mills.com.br"]),
    ] }));
    const o = await cal.ocupados(t("00:00"), t("23:59"), { internos: INTERNOS });
    expect(o.cliente).toEqual([{ start: t("14:00"), end: t("15:00") }]);
    expect(o.google).toHaveLength(3);
    expect(isFreeOcupado(o, t("15:00"), t("16:00"), 30)).toBe(false);  // logo depois da reunião com cliente (caso da Alessandra)
    expect(isFreeOcupado(o, t("15:30"), t("16:30"), 30)).toBe(true);
    expect(isFreeOcupado(o, t("13:15"), t("13:45"), 30)).toBe(false);  // só 15 min antes da reunião com cliente
    expect(isFreeOcupado(o, t("13:00"), t("13:30"), 30)).toBe(true);   // meia hora antes; e logo depois do almoço, sem intervalo
    expect(isFreeOcupado(o, t("11:00"), t("12:00"), 30)).toBe(true);   // entre a reunião interna e o almoço, sem intervalo
  });
  it("evento de dia inteiro ocupa o dia no fuso de São Paulo", async () => {
    const cal = new GoogleCalendar("tk", async () => json(200, { items: [{ id: "ferias", start: { date: "2026-10-12" }, end: { date: "2026-10-13" } }] }));
    expect((await cal.ocupados(t("00:00"), t("23:59"), { internos: INTERNOS })).google).toEqual([{ start: t("00:00"), end: new Date("2026-10-13T00:00:00-03:00") }]);
  });
  it("sala de reunião (recurso) não faz do evento uma reunião com cliente", async () => {
    const cal = new GoogleCalendar("tk", async () => json(200, { items: [{ id: "x", start: { dateTime: t("10:00").toISOString() }, end: { dateTime: t("11:00").toISOString() },
      attendees: [{ email: "sala@resource.calendar.google.com", resource: true }, { email: "x@poli.digital" }] }] }));
    expect((await cal.ocupados(t("00:00"), t("23:59"), { internos: INTERNOS })).cliente).toEqual([]);
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

describe("título no arquivo", () => {
  it("ganha o closer no final ao arquivar e perde ao voltar; não duplica", () => {
    expect(archiveTitle("Apresentação Poli - Empresa X", "Calil")).toBe("Apresentação Poli - Empresa X (Calil)");
    expect(archiveTitle("Apresentação Poli - Empresa X (Calil)", "Ana")).toBe("Apresentação Poli - Empresa X (Ana)");
    expect(activeTitle("Apresentação Poli - Empresa X (Calil)")).toBe("Apresentação Poli - Empresa X");
    expect(activeTitle("Apresentação Poli - Empresa X")).toBe("Apresentação Poli - Empresa X");
  });
});
