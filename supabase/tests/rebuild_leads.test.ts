// Regra de bloco e estado dos chats (painel.rebuild_leads).
// As sequências marcadas "real" foram extraídas de public.raw_events em 2026-10-04 e anonimizadas:
// só ficaram a classe do remetente, os segundos desde o início e o dono (letra). Sem texto, telefone ou ids.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDb } from "./db";

type Kind =
  | "lead"          // mensagem do lead
  | "sdr"           // mensagem escrita pelo dono do chat
  | "sdr_outro"     // mensagem escrita por outra pessoa da equipe no chat do dono
  | "template"      // template enviado manualmente por uma pessoa
  | "template_bot"  // template do app token
  | "bot"           // automação sem autor
  | `system:${string}`;

// [tipo, segundos desde o início, chat (padrão "A"), dono (padrão "X")]
type Step = [Kind, number, string?, string?];

// Segunda-feira, 05/10/2026, 09:00 em São Paulo.
const T0 = Date.parse("2026-10-05T09:00:00-03:00");

let db: PGlite;
let seq = 0;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec(`
    delete from painel.response_events; delete from painel.chat_owner_history;
    delete from painel.chat_messages; delete from painel.chats; delete from painel.leads; delete from painel.sdrs;
  `);
});

async function id(sql: string, params: unknown[]): Promise<string> {
  return (await db.query<{ id: string }>(sql, params)).rows[0].id;
}

/** Monta um lead com seus atendimentos e mensagens, roda rebuild_leads e devolve os ids. */
async function scenario(steps: Step[], opts: { shuffle?: boolean } = {}) {
  const lead = await id("insert into painel.leads (poli_contact_uuid) values ($1) returning id", [`c${++seq}`]);
  const sdrs = new Map<string, string>();
  const chats = new Map<string, string>();
  const sdrId = async (k: string) =>
    sdrs.get(k) ??
    sdrs.set(k, await id("insert into painel.sdrs (poli_email, name, role) values ($1, $1, 'sdr') returning id", [`${k}${seq}@x`])).get(k)!;
  const chatId = async (k: string, owner: string) =>
    chats.get(k) ??
    chats.set(k, await id(
      "insert into painel.chats (poli_attendance_uuid, lead_id, sdr_id, opened_at) values ($1, $2, $3, now()) returning id",
      [`a${seq}${k}`, lead, await sdrId(owner)],
    )).get(k)!;

  const rows = steps.map(([kind, sec, chat = "A", owner = "X"], i) => ({ kind, sec, chat, owner, i }));
  if (opts.shuffle) rows.sort(() => Math.random() - 0.5);
  for (const r of rows) {
    const system = r.kind.startsWith("system:");
    const sender = system ? "system" : r.kind === "sdr_outro" ? "sdr" : r.kind === "template_bot" ? "template" : r.kind;
    const byHuman = ["sdr", "sdr_outro", "template"].includes(r.kind);
    await db.query(
      `insert into painel.chat_messages
         (poli_message_id, chat_id, lead_id, sdr_id, sender, sent_at, by_human, system_type, attendance_status, closed_reason)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        `m${seq}-${r.i}`, await chatId(r.chat, r.owner), lead, await sdrId(r.owner), sender,
        new Date(T0 + r.sec * 1000).toISOString(), byHuman, system ? r.kind.slice(7) : null,
        r.kind === "system:ATTENDANCE_CLOSED" ? "CLOSED" : "IN_PROGRESS",
        r.kind === "system:ATTENDANCE_CLOSED" ? "FINISHED_BY_USER" : null,
      ],
    );
  }
  await db.query("select painel.rebuild_leads($1::uuid[])", [[lead]]);
  return { lead, sdrs, chats };
}

async function responses(lead: string) {
  const res = await db.query<{ chat: string; sdr: string; secs: number; biz: number; first: boolean; started: string }>(
    `select r.chat_id as chat, r.sdr_id as sdr, r.seconds_24h as secs, r.seconds_business as biz,
            r.is_first_response as first, r.lead_block_started_at::text as started
       from painel.response_events r join painel.chats c on c.id = r.chat_id
      where c.lead_id = $1 order by r.lead_block_started_at`,
    [lead],
  );
  return res.rows;
}

async function chat(chatId: string) {
  return (await db.query<{ status: string; closed_reason: string | null; last_message_from: string; sdr_id: string }>(
    "select status, closed_reason, last_message_from, sdr_id from painel.chats where id = $1", [chatId],
  )).rows[0];
}

describe("rebuild_leads: tempo de resposta", () => {
  it("real: rajada do lead — relógio começa na primeira mensagem do bloco; template do bot não é resposta", async () => {
    const s = await scenario([
      ["sdr", 0], ["template_bot", 3185], ["lead", 3300], ["sdr", 3675], ["lead", 3704], ["sdr", 3716], ["sdr", 3729],
      ["template_bot", 89337], ["sdr", 107834], ["lead", 109460], ["lead", 109463], ["lead", 109489], ["sdr", 109497],
    ]);
    const r = await responses(s.lead);
    expect(r.map((x) => x.secs)).toEqual([375, 12, 37]);
    expect(r.map((x) => x.first)).toEqual([true, false, false]);
  });

  it("real: app token dispara template, lead responde, mede até a primeira mensagem de uma pessoa", async () => {
    const s = await scenario([
      ["template_bot", 0], ["lead", 3], ["template_bot", 18000], ["sdr", 20602],
      ["template_bot", 86400], ["sdr", 92311], ["template_bot", 104400],
    ]);
    const r = await responses(s.lead);
    expect(r.map((x) => [x.secs, x.first])).toEqual([[20599, true]]);
  });

  it("real: outra pessoa da equipe responde no chat do dono — conta e vai para o dono", async () => {
    const s = await scenario([["template", 0], ["lead", 3740], ["sdr_outro", 5349]]);
    const r = await responses(s.lead);
    expect(r.map((x) => x.secs)).toEqual([1609]);
    expect(r[0].sdr).toBe(s.sdrs.get("X"));
  });

  it("template enviado manualmente por uma pessoa conta como resposta", async () => {
    const s = await scenario([["lead", 0], ["template", 600]]);
    expect((await responses(s.lead)).map((x) => x.secs)).toEqual([600]);
  });

  it("bot sem autor não é resposta e não interrompe o bloco", async () => {
    const s = await scenario([["lead", 0], ["bot", 10], ["lead", 20], ["sdr", 100]]);
    const r = await responses(s.lead);
    expect(r.map((x) => x.secs)).toEqual([100]);
  });

  it("real: lead sem resposta no fim não entra; os blocos respondidos entram", async () => {
    const s = await scenario([
      ["template", 0], ["lead", 156], ["sdr", 223], ["lead", 804], ["sdr", 915],
      ["lead", 13749], ["lead", 13762], ["sdr", 18011], ["lead", 19151],
    ]);
    expect((await responses(s.lead)).map((x) => x.secs)).toEqual([67, 111, 4262]);
    const c = await chat(s.chats.get("A")!);
    expect(c.status).toBe("open");
    expect(c.last_message_from).toBe("lead");
  });

  it("real: nota interna (SYSTEM NOTE) no meio não é resposta", async () => {
    const s = await scenario([
      ["template", 0], ["lead", 84], ["sdr", 693], ["sdr", 20808], ["sdr", 20839], ["system:NOTE", 20848],
      ["lead", 20858], ["sdr", 21345], ["sdr", 21363], ["sdr", 21385], ["lead", 21386],
    ]);
    expect((await responses(s.lead)).map((x) => x.secs)).toEqual([609, 487]);
  });

  it("real: resposta em outro atendimento do mesmo lead encerra a espera, creditada ao chat onde o lead escreveu", async () => {
    // Padrão real: lead escreve no atendimento B e o SDR responde no A.
    const s = await scenario([
      ["sdr", 0, "A"], ["sdr", 60, "A"], ["lead", 36 * 60, "B"], ["sdr", 41 * 60, "A"],
      ["lead", 330 * 60, "B"], ["sdr", 350 * 60, "A"],
    ]);
    const r = await responses(s.lead);
    expect(r.map((x) => [x.chat === s.chats.get("B"), x.secs, x.first])).toEqual([[true, 300, true], [true, 1200, false]]);
  });

  it("guarda também o tempo em horário comercial", async () => {
    // Segunda 17:30 → terça 08:30: 15h corridas; 25 min no horário configurado (17:30–17:45 + 08:20–08:30).
    const s = await scenario([["lead", 8.5 * 3600], ["sdr", 23.5 * 3600]]);
    const r = await responses(s.lead);
    expect(r[0].secs).toBe(15 * 3600);
    expect(r[0].biz).toBe(25 * 60);
  });

  it("é idempotente e não depende da ordem em que as mensagens chegaram", async () => {
    const steps: Step[] = [["lead", 0], ["lead", 5], ["sdr", 50], ["template_bot", 60], ["lead", 70], ["sdr_outro", 90]];
    const a = await scenario(steps, { shuffle: true });
    const first = await responses(a.lead);
    await db.query("select painel.rebuild_leads($1::uuid[])", [[a.lead]]);
    expect(await responses(a.lead)).toEqual(first);
    expect(first.map((x) => x.secs)).toEqual([50, 20]);
  });
});

describe("rebuild_leads: estado do chat", () => {
  it("real: encerrado pelo usuário fica fechado com o motivo da Poli", async () => {
    const s = await scenario([
      ["template", 0], ["template", 21995], ["template_bot", 87839], ["template_bot", 105839],
      ["sdr", 111835], ["lead", 113877], ["system:ATTENDANCE_CLOSED", 113962],
    ]);
    const c = await chat(s.chats.get("A")!);
    expect(c.status).toBe("closed");
    expect(c.closed_reason).toBe("FINISHED_BY_USER");
  });

  it("atendimento antigo nunca encerrado pela Poli fecha quando o lead segue em outro atendimento", async () => {
    const s = await scenario([["lead", 0, "A"], ["sdr", 60, "A"], ["template_bot", 3600, "B"], ["lead", 4000, "B"]]);
    expect(await chat(s.chats.get("A")!)).toMatchObject({ status: "closed", closed_reason: "SUBSTITUIDO" });
    expect((await chat(s.chats.get("B")!)).status).toBe("open");
  });

  it("template do app token num atendimento antigo não reabre ele nem fecha o atendimento onde o lead espera", async () => {
    const s = await scenario([["lead", 0, "B"], ["template_bot", 600, "A"]]);
    expect((await chat(s.chats.get("B")!)).status).toBe("open");
  });

  it("quem iniciou: primeira mensagem do lead ou da Poli, ignorando eventos de sistema", async () => {
    const s = await scenario([
      ["system:ATTENDANCE_REDIRECTED", 0, "A"], ["lead", 10, "A"], ["sdr", 20, "A"],
      ["template_bot", 100, "B"], ["lead", 200, "B"],
      ["sdr", 300, "C"],
    ]);
    const by = async (k: string) => (await db.query<{ v: string }>("select initiated_by as v from painel.chats where id = $1", [s.chats.get(k)])).rows[0].v;
    expect([await by("A"), await by("B"), await by("C")]).toEqual(["lead", "poli", "poli"]);
  });

  it("registra a troca de dono no histórico", async () => {
    const s = await scenario([["lead", 0, "A", "X"], ["sdr", 60, "A", "X"], ["lead", 120, "A", "Y"], ["sdr", 180, "A", "Y"]]);
    const h = await db.query<{ sdr: string; to_at: string | null }>(
      "select sdr_id as sdr, to_at from painel.chat_owner_history where chat_id = $1 order by from_at", [s.chats.get("A")],
    );
    expect(h.rows.map((r) => r.sdr)).toEqual([s.sdrs.get("X"), s.sdrs.get("Y")]);
    expect(h.rows[1].to_at).toBeNull();
    expect((await chat(s.chats.get("A")!)).sdr_id).toBe(s.sdrs.get("Y"));
  });
});
