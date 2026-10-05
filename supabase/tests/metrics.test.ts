// Funções da tela: painel.sdr_metrics, painel.team_metrics, painel.sdr_chats (Fase 4).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDb } from "./db";

type Kind = "lead" | "sdr" | "template" | "template_bot" | "bot";
// [tipo, horário ISO, chat]
type Step = [Kind, string, string?];

let db: PGlite;
let seq = 0;
const sdr: Record<string, string> = {};

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec(`
    reset role;
    select set_config('request.jwt.claims', '{"role":"service_role"}', false);
    select set_config('request.jwt.claim.sub', '', false);
    delete from painel.response_events; delete from painel.chat_owner_history; delete from painel.chat_messages;
    delete from painel.chats; delete from painel.leads; delete from painel.profiles; delete from auth.users; delete from painel.sdrs;
  `);
  for (const [k, role] of [["X", "sdr"], ["Y", "sdr"], ["G", "gestor"]] as const) {
    sdr[k] = (await db.query<{ id: string }>(
      "insert into painel.sdrs (poli_email, name, role) values ($1, $2, $3) returning id", [`${k.toLowerCase()}@x`, `SDR ${k}`, role],
    )).rows[0].id;
  }
});

/** Cria um lead com mensagens (todos os chats com dono `owner`) e roda rebuild_leads. */
async function lead(owner: string, steps: Step[], info: { name?: string; phone?: string } = {}) {
  const leadId = (await db.query<{ id: string }>(
    "insert into painel.leads (poli_contact_uuid, name, phone_e164) values ($1, $2, $3) returning id",
    [`c${++seq}`, info.name ?? `Lead ${seq}`, info.phone ?? null],
  )).rows[0].id;
  const chats = new Map<string, string>();
  for (const [i, [kind, at, chat = "A"]] of steps.entries()) {
    if (!chats.has(chat)) {
      chats.set(chat, (await db.query<{ id: string }>(
        "insert into painel.chats (poli_attendance_uuid, lead_id, sdr_id, opened_at) values ($1, $2, $3, now()) returning id",
        [`a${seq}${chat}`, leadId, sdr[owner]],
      )).rows[0].id);
    }
    const sender = kind === "template_bot" ? "template" : kind;
    await db.query(
      `insert into painel.chat_messages (poli_message_id, chat_id, lead_id, sdr_id, sender, sent_at, by_human)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [`m${seq}-${i}`, chats.get(chat), leadId, sdr[owner], sender, at, kind === "sdr" || kind === "template"],
    );
  }
  await db.query("select painel.rebuild_leads($1::uuid[])", [[leadId]]);
  return { leadId, chats };
}

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
// Segunda-feira 05/10/2026 (fuso -03).
const day = (hhmm: string, d = "05") => `2026-10-${d}T${hhmm}:00-03:00`;
const FROM = day("00:00");
const TO = day("00:00", "06");

async function metrics(business = false) {
  const res = await db.query<Record<string, number | string | null>>(
    "select * from painel.sdr_metrics($1, $2, $3)", [FROM, TO, business],
  );
  return Object.fromEntries(res.rows.map((r) => [r.name, r]));
}

describe("sdr_metrics", () => {
  it("leads abordados, templates enviados e leads que responderam, só no período", async () => {
    await lead("X", [["template_bot", day("09:00")], ["lead", day("09:05")], ["sdr", day("09:07")]]);
    await lead("X", [["template", day("10:00")], ["template", day("15:00")]]);
    await lead("X", [["template", day("10:00", "04")], ["lead", day("11:00")]]); // template fora do período
    const m = (await metrics())["SDR X"];
    expect(m).toMatchObject({ leads_abordados: 2, templates_enviados: 3, leads_responderam: 2 });
  });

  it("medianas de 1ª resposta e de resposta, com a opção de horário comercial", async () => {
    await lead("X", [["lead", day("09:00")], ["sdr", day("09:01")], ["lead", day("09:10")], ["sdr", day("09:20")]]); // 60s (1ª), 600s
    await lead("X", [["lead", day("10:00")], ["sdr", day("10:02")]]); // 120s (1ª)
    await lead("X", [["lead", day("17:30", "04")], ["sdr", day("08:30")]]); // dom 17:30 → seg 08:30: 54000s, 1800s comerciais
    const m = (await metrics())["SDR X"];
    expect(m).toMatchObject({ primeiras_respostas: 3, primeira_resposta_s: 120, respostas: 4, resposta_s: 360 });
    const b = (await metrics(true))["SDR X"];
    expect(b).toMatchObject({ primeira_resposta_s: 120, resposta_s: 360 });
    // Mediana de [60, 120, 1800] com horário comercial = 120; corrido = mediana de [60, 120, 54000] = 120.
    const res = await db.query<{ s: number }>(
      "select primeira_resposta_s as s from painel.sdr_metrics($1, $2, true) where name = 'SDR X'", [FROM, TO],
    );
    expect(res.rows[0].s).toBe(120);
  });

  it("horário comercial muda a mediana quando a resposta atravessa a noite", async () => {
    await lead("X", [["lead", day("17:00")], ["sdr", day("09:00", "06")]]); // 16h corridas, 2h comerciais
    const m = await db.query<{ c: number; b: number }>(
      `select (select resposta_s from painel.sdr_metrics($1, $2, false) where name = 'SDR X') as c,
              (select resposta_s from painel.sdr_metrics($1, $2, true) where name = 'SDR X') as b`,
      [FROM, day("00:00", "07")],
    );
    expect(m.rows[0]).toEqual({ c: 16 * 3600, b: 2 * 3600 });
  });

  it("aguardando e parados: estado de agora, com o limite de 30 min", async () => {
    await lead("X", [["sdr", ago(120)], ["lead", ago(40)]]);                // parado
    await lead("X", [["lead", ago(5)]]);                                    // aguardando, não parado
    await lead("X", [["lead", ago(50)], ["sdr", ago(45)]]);                 // respondido
    await lead("X", [["lead", ago(60)], ["template_bot", ago(30)]]);        // template do app token não responde: aguardando
    const m = (await db.query<{ aguardando: number; parados: number }>(
      "select aguardando, parados from painel.sdr_metrics(now() - interval '1 day', now() + interval '1 minute') where name = 'SDR X'",
    )).rows[0];
    expect(m).toEqual({ aguardando: 3, parados: 2 });
  });

  it("só lista SDRs (gestor fica fora) e quem não tem dado aparece zerado", async () => {
    await lead("G", [["lead", day("09:00")], ["sdr", day("09:01")]]);
    const m = await metrics();
    expect(Object.keys(m)).toEqual(["SDR X", "SDR Y"]);
    expect(m["SDR Y"]).toMatchObject({ leads_abordados: 0, respostas: 0, resposta_s: null, aguardando: 0 });
  });
});

describe("team_metrics", () => {
  it("mediana do time sobre todas as respostas, não média das medianas", async () => {
    await lead("X", [["lead", day("09:00")], ["sdr", day("09:01")], ["lead", day("09:10")], ["sdr", day("09:12")]]); // 60, 120
    await lead("Y", [["lead", day("09:00")], ["sdr", day("09:50")]]); // 3000
    const t = (await db.query<Record<string, number>>("select * from painel.team_metrics($1, $2, false)", [FROM, TO])).rows[0];
    // Medianas por SDR: X = 90, Y = 3000 (média 1545). Mediana do time = mediana de [60, 120, 3000] = 120.
    expect(t).toMatchObject({ sdrs: 2, respostas: 3, resposta_s: 120, primeiras_respostas: 2, primeira_resposta_s: 1530 });
  });
});

describe("sdr_chats", () => {
  it("lista os chats do SDR com situação, contagens, origem e telefone mascarado", async () => {
    await lead("X", [["template_bot", ago(100)], ["lead", ago(90)], ["sdr", ago(88)], ["lead", ago(40)]], { name: "Clínica Sorriso", phone: "+5562912341187" });
    await lead("X", [["template", ago(30)]], { name: "Pet Shop" });
    await lead("X", [["lead", ago(20)], ["sdr", ago(18)]], { name: "Mercado" });
    await lead("Y", [["lead", ago(10)]], { name: "De outro SDR" });
    const rows = (await db.query<Record<string, unknown>>(
      "select * from painel.sdr_chats($1, now() - interval '1 day', now() + interval '1 minute')", [sdr.X],
    )).rows;
    expect(rows.map((r) => [r.lead_name, r.situacao, r.parado])).toEqual([
      ["Clínica Sorriso", "aguardando", true],
      ["Mercado", "respondido", false],
      ["Pet Shop", "lead_nao_respondeu", false],
    ]);
    expect(rows[0]).toMatchObject({
      phone_masked: "(62) 9••••-1187", templates: 1, msgs_lead: 2, msgs_equipe: 1,
      primeira_resposta_s: 120, origem: "poli", total: 3,
    });
    expect(rows[1]).toMatchObject({ origem: "lead", primeira_resposta_s: 120 });
  });

  it("filtros, busca por nome ou telefone e paginação", async () => {
    await lead("X", [["lead", ago(40)]], { name: "Clínica Sorriso", phone: "+5562912341187" });
    await lead("X", [["template", ago(30)]], { name: "Pet Shop", phone: "+5511988887777" });
    await lead("X", [["lead", ago(20)], ["sdr", ago(18)]], { name: "Mercado" });
    const q = async (filter: string, search: string | null, limit = 50, offset = 0) =>
      (await db.query<{ lead_name: string; total: number }>(
        "select lead_name, total from painel.sdr_chats($1, now() - interval '1 day', now() + interval '1 minute', false, $2, $3, $4, $5)",
        [sdr.X, filter, search, limit, offset],
      )).rows;
    expect((await q("waiting", null)).map((r) => r.lead_name)).toEqual(["Clínica Sorriso"]);
    expect((await q("noreply", null)).map((r) => r.lead_name)).toEqual(["Pet Shop"]);
    expect((await q("all", "sorriso")).map((r) => r.lead_name)).toEqual(["Clínica Sorriso"]);
    expect((await q("all", "8888-7777")).map((r) => r.lead_name)).toEqual(["Pet Shop"]);
    const page = await q("all", null, 1, 1);
    expect(page).toHaveLength(1);
    expect(page[0].total).toBe(3);
  });

  it("só chats com mensagem no período", async () => {
    await lead("X", [["lead", day("09:00", "01")], ["sdr", day("09:05", "01")]], { name: "Antigo" });
    await lead("X", [["lead", day("09:00")], ["sdr", day("09:05")]], { name: "Hoje" });
    const rows = (await db.query<{ lead_name: string }>("select lead_name from painel.sdr_chats($1, $2, $3)", [sdr.X, FROM, TO])).rows;
    expect(rows.map((r) => r.lead_name)).toEqual(["Hoje"]);
  });
});

describe("quem iniciou, por lead", () => {
  it("vale a primeira mensagem do primeiro atendimento, mesmo que o lead inicie um atendimento depois", async () => {
    const { leadId } = await lead("X", [["template_bot", day("09:00"), "A"], ["lead", day("10:00"), "B"]]);
    const r = await db.query<{ v: string }>("select initiated_by as v from painel.leads where id = $1", [leadId]);
    expect(r.rows[0].v).toBe("poli");
  });
});

describe("acesso", () => {
  it("sem login: acesso negado", async () => {
    await db.exec(`select set_config('request.jwt.claims', '', false); set role anon;`);
    await expect(db.query("select * from painel.sdr_metrics(now(), now())")).rejects.toThrow(/permission denied|acesso negado/);
    await db.exec("reset role");
  });

  it("usuário ativo vê; usuário desativado não", async () => {
    const uid = "00000000-0000-0000-0000-0000000000aa";
    await db.exec(`insert into auth.users (id) values ('${uid}'); insert into painel.profiles (id, name) values ('${uid}', 'Gestor');`);
    const asUser = async () => {
      await db.exec(`select set_config('request.jwt.claims', '{"role":"authenticated"}', false);
                     select set_config('request.jwt.claim.sub', '${uid}', false); set role authenticated;`);
      try {
        return await db.query("select * from painel.team_metrics(now() - interval '1 day', now())");
      } finally {
        await db.exec("reset role");
      }
    };
    expect((await asUser()).rows).toHaveLength(1);
    await db.exec(`update painel.profiles set active = false where id = '${uid}'`);
    await expect(asUser()).rejects.toThrow(/acesso negado/);
  });
});
