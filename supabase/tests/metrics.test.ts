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
    delete from painel.hubspot_leads; delete from painel.hubspot_stages; delete from painel.hubspot_owners;
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

  it("medianas entram no período pelo momento em que o lead escreveu", async () => {
    await lead("X", [["lead", day("09:00")], ["sdr", day("09:01")], ["lead", day("09:10")], ["sdr", day("09:20")]]); // 60s (1ª), 600s
    await lead("X", [["lead", day("10:00")], ["sdr", day("10:02")]]); // 120s (1ª)
    await lead("X", [["lead", day("17:30", "04")], ["sdr", day("08:30")]]); // lead escreveu ontem: fora da mediana de hoje
    const m = (await metrics())["SDR X"];
    expect(m).toMatchObject({ leads_primeira_resposta: 2, primeira_resposta_s: 90, leads_resposta: 2, resposta_s: 120 }); // 3 respostas, 2 leads
  });

  it("só horário comercial: só leads que escreveram no expediente (08:20–17:45), com o tempo real", async () => {
    await lead("X", [["lead", day("17:00")], ["sdr", day("09:00", "06")]]); // escreveu 17:00 (no expediente): 16h reais
    await lead("X", [["lead", day("19:00")], ["sdr", day("08:30", "06")]]); // escreveu 19:00 (fora do expediente): 13,5h
    const m = await db.query<{ c: number; nc: number; b: number; nb: number }>(
      `select (select resposta_s from painel.sdr_metrics($1, $2, false) where name = 'SDR X') as c,
              (select leads_resposta from painel.sdr_metrics($1, $2, false) where name = 'SDR X') as nc,
              (select resposta_s from painel.sdr_metrics($1, $2, true) where name = 'SDR X') as b,
              (select leads_resposta from painel.sdr_metrics($1, $2, true) where name = 'SDR X') as nb`,
      [FROM, TO],
    );
    expect(m.rows[0]).toEqual({ c: (16 + 13.5) / 2 * 3600, nc: 2, b: 16 * 3600, nb: 1 });
  });

  it("sem parâmetro, segue a configuração metrics_business_only (padrão: marcada)", async () => {
    await lead("X", [["lead", day("09:00")], ["sdr", day("09:10")]]);  // no expediente: 600s
    await lead("X", [["lead", day("20:00")], ["sdr", day("20:01")]]);  // fora do expediente: 60s
    const q = async () => (await db.query<{ n: number }>(
      "select leads_resposta as n from painel.sdr_metrics($1, $2) where name = 'SDR X'", [FROM, TO],
    )).rows[0].n;
    expect(await q()).toBe(1);
    await db.exec("update painel.settings set value = 'false' where key = 'metrics_business_only'");
    expect(await q()).toBe(2);
    await db.exec("update painel.settings set value = 'true' where key = 'metrics_business_only'");
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
    expect(m["SDR Y"]).toMatchObject({ leads_abordados: 0, leads_resposta: 0, resposta_s: null, aguardando: 0 });
  });
});

describe("HubSpot: descartado e qualificado saem de Aguardando e Parados", () => {
  it("vale a etapa do Lead mais recente do contato; a tabela mostra fora_do_funil com o nome da etapa", async () => {
    await db.exec(`
      insert into painel.hubspot_stages (stage_id, pipeline_id, label, state) values
        ('1250901141', '841793591', 'Descartado', 'UNQUALIFIED'),
        ('1250901139', '841793591', 'Garantir Agendamento', 'IN_PROGRESS'),
        ('1358962969', '841793591', 'Qualificado', 'QUALIFIED');
    `);
    const a = await lead("X", [["lead", ago(60)]], { name: "Descartado" });
    const b = await lead("X", [["lead", ago(60)]], { name: "Garantir" });
    const c = await lead("X", [["lead", ago(60)]], { name: "Voltou" });
    const d = await lead("X", [["lead", ago(60)]], { name: "Qualificado" });
    const link = async (leadId: string, contact: string) => db.query("update painel.leads set hubspot_contact_id = $2 where id = $1", [leadId, contact]);
    await link(a.leadId, "h1"); await link(b.leadId, "h2"); await link(c.leadId, "h3"); await link(d.leadId, "h4");
    await db.exec(`
      insert into painel.hubspot_leads (hubspot_lead_id, hubspot_contact_id, pipeline_id, stage_id, created_at) values
        ('L1', 'h1', '841793591', '1250901141', '2026-09-01'),
        ('L2', 'h2', '841793591', '1250901139', '2026-09-01'),
        ('L3a', 'h3', '841793591', '1250901141', '2026-08-01'),  -- descartado antigo
        ('L3b', 'h3', '841793591', '1250901139', '2026-10-01'),  -- Lead novo, em aberto: volta a contar
        ('L4', 'h4', '841793591', '1358962969', '2026-09-01');
    `);
    const m = (await db.query<{ aguardando: number; parados: number }>(
      "select aguardando, parados from painel.sdr_metrics(now() - interval '1 day', now() + interval '1 minute') where name = 'SDR X'",
    )).rows[0];
    expect(m).toEqual({ aguardando: 2, parados: 2 });
    const t = (await db.query<{ aguardando: number }>("select aguardando from painel.team_metrics(now() - interval '1 day', now() + interval '1 minute')")).rows[0];
    expect(t.aguardando).toBe(2);
    const rows = (await db.query<{ lead_name: string; situacao: string; fora_motivo: string | null }>(
      "select lead_name, situacao, fora_motivo from painel.sdr_chats($1, now() - interval '1 day', now() + interval '1 minute') order by lead_name", [sdr.X],
    )).rows;
    expect(rows).toEqual([
      { lead_name: "Descartado", situacao: "fora_do_funil", fora_motivo: "Descartado" },
      { lead_name: "Garantir", situacao: "aguardando", fora_motivo: null },
      { lead_name: "Qualificado", situacao: "fora_do_funil", fora_motivo: "Qualificado" },
      { lead_name: "Voltou", situacao: "aguardando", fora_motivo: null },
    ]);
  });
});

describe("nota interna de descarte", () => {
  it("tira o lead de Aguardando até existir no HubSpot um Lead novo, criado depois da nota e fora do descarte", async () => {
    await db.exec(`insert into painel.hubspot_stages (stage_id, pipeline_id, label, state) values
      ('1250901141', '841793591', 'Descartado', 'UNQUALIFIED'), ('1250901139', '841793591', 'Garantir Agendamento', 'IN_PROGRESS')`);
    const a = await lead("X", [["lead", ago(120)]], { name: "Nota" });
    await db.query("update painel.leads set hubspot_contact_id = 'hn' where id = $1", [a.leadId]);
    await db.query(
      `insert into painel.chat_messages (poli_message_id, chat_id, lead_id, sdr_id, sender, sent_at, system_type, note_tag)
       values ('nota-1', $1, $2, $3, 'system', $4, 'NOTE', 'descartado')`,
      [a.chats.get("A"), a.leadId, sdr.X, ago(100)],
    );
    // lead escreve de novo depois da nota: continua fora
    await db.query(
      "insert into painel.chat_messages (poli_message_id, chat_id, lead_id, sdr_id, sender, sent_at) values ('depois', $1, $2, $3, 'lead', $4)",
      [a.chats.get("A"), a.leadId, sdr.X, ago(50)],
    );
    await db.query("select painel.rebuild_leads($1::uuid[])", [[a.leadId]]);
    const q = async () => (await db.query<{ situacao: string; fora_motivo: string | null }>(
      "select situacao, fora_motivo from painel.sdr_chats($1, now() - interval '1 day', now() + interval '1 minute')", [sdr.X],
    )).rows[0];
    expect(await q()).toEqual({ situacao: "fora_do_funil", fora_motivo: "Descartado (nota)" });
    // Lead antigo no HubSpot (antes da nota) não traz de volta
    await db.query("insert into painel.hubspot_leads (hubspot_lead_id, hubspot_contact_id, stage_id, created_at) values ('old', 'hn', '1250901139', $1)", [ago(300)]);
    expect((await q()).situacao).toBe("fora_do_funil");
    // Lead novo, criado depois da nota, em etapa aberta: volta a contar
    await db.query("insert into painel.hubspot_leads (hubspot_lead_id, hubspot_contact_id, stage_id, created_at) values ('new', 'hn', '1250901139', $1)", [ago(10)]);
    expect(await q()).toEqual({ situacao: "aguardando", fora_motivo: null });
  });
});

describe("Descartados e DSQ (HubSpot)", () => {
  it("Descartados no card do SDR pelo dono do Lead; DSQ só no Time, de qualquer dono", async () => {
    await db.exec(`
      insert into painel.hubspot_owners (owner_id, email) values ('o-x', 'x@x'), ('o-g', 'g@x');
      insert into painel.hubspot_leads (hubspot_lead_id, owner_id, entered_descartado_at, entered_dsq_at) values
        ('d1', 'o-x', '${day("10:00")}', null),
        ('d2', 'o-x', '${day("16:00")}', null),
        ('d3', 'o-x', '${day("10:00", "04")}', null),   -- ontem: fora do período
        ('d4', 'o-g', '${day("11:00")}', null),          -- dono gestor: não é SDR
        ('q1', 'o-g', null, '${day("09:00")}'),
        ('q2', 'o-x', null, '${day("12:00")}');
    `);
    const m = await metrics();
    expect(m["SDR X"].descartados).toBe(2);
    expect(m["SDR Y"].descartados).toBe(0);
    const t = (await db.query<{ descartados: number; dsq: number }>("select descartados, dsq from painel.team_metrics($1, $2)", [FROM, TO])).rows[0];
    expect(t).toEqual({ descartados: 2, dsq: 2 });
  });
});

describe("team_metrics", () => {
  it("mediana do time sobre todas as respostas, não média das medianas", async () => {
    await lead("X", [["lead", day("09:00")], ["sdr", day("09:01")], ["lead", day("09:10")], ["sdr", day("09:12")]]); // 60, 120
    await lead("Y", [["lead", day("09:00")], ["sdr", day("09:50")]]); // 3000
    const t = (await db.query<Record<string, number>>("select * from painel.team_metrics($1, $2, false)", [FROM, TO])).rows[0];
    // Medianas por SDR: X = 90, Y = 3000 (média 1545). Mediana do time = mediana de [60, 120, 3000] = 120.
    expect(t).toMatchObject({ sdrs: 2, leads_resposta: 2, resposta_s: 120, leads_primeira_resposta: 2, primeira_resposta_s: 1530 });
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

  it("chat fechado com o lead sem resposta aparece como encerrado sem resposta", async () => {
    const { chats } = await lead("X", [["lead", ago(20)], ["lead", ago(15)]], { name: "Transferido" });
    await db.query("update painel.chat_messages set attendance_status = 'CLOSED' where chat_id = $1", [chats.get("A")]);
    const leadId = (await db.query<{ id: string }>("select lead_id as id from painel.chats where id = $1", [chats.get("A")])).rows[0].id;
    await db.query("select painel.rebuild_leads($1::uuid[])", [[leadId]]);
    const rows = (await db.query<{ situacao: string }>(
      "select situacao from painel.sdr_chats($1, now() - interval '1 day', now() + interval '1 minute')", [sdr.X],
    )).rows;
    expect(rows.map((r) => r.situacao)).toEqual(["encerrado_sem_resposta"]);
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
