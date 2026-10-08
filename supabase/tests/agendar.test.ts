// Fase 10d.1: funções do agendamento. Busca de lead no escopo do SDR, reuniões do lead, passagem de bastão só
// para quem pode, lead preso ao closer também pelo contato do HubSpot, lead sem chat (plano B).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDb } from "./db";

let db: PGlite;
const uid = {
  sdrA: "00000000-0000-0000-0000-0000000004a1", sdrB: "00000000-0000-0000-0000-0000000004a2",
  closerA: "00000000-0000-0000-0000-0000000004a3", closerB: "00000000-0000-0000-0000-0000000004a4",
  gestor: "00000000-0000-0000-0000-0000000004a5",
};
const id: Record<string, string> = {};

async function as<T = Record<string, unknown>>(user: string, sql: string, params: unknown[] = []): Promise<T[]> {
  await db.exec(`select set_config('request.jwt.claims', '{"role":"authenticated"}', false);
                 select set_config('request.jwt.claim.sub', '${user}', false); set role authenticated;`);
  try {
    return (await db.query<T>(sql, params)).rows;
  } finally {
    await db.exec(`reset role; select set_config('request.jwt.claims', '{"role":"service_role"}', false);
                   select set_config('request.jwt.claim.sub', '', false);`);
  }
}
const one = async (sql: string, params: unknown[] = []) => (await db.query<{ id: string }>(sql, params)).rows[0].id;

beforeAll(async () => {
  db = await createTestDb();
  await db.exec(`select set_config('request.jwt.claims', '{"role":"service_role"}', false);`);
  id.sdrA = await one("insert into painel.sdrs (poli_email, name, role) values ('sa@x', 'SDR A', 'sdr') returning id");
  id.sdrB = await one("insert into painel.sdrs (poli_email, name, role) values ('sb@x', 'SDR B', 'sdr') returning id");
  id.closerA = await one("insert into painel.sdrs (poli_email, name, role) values ('ca@x', 'Closer A', 'closer') returning id");
  id.closerB = await one("insert into painel.sdrs (poli_email, name, role) values ('cb@x', 'Closer B', 'closer') returning id");
  for (const c of [id.closerA, id.closerB]) {
    await db.query("insert into painel.google_connections (closer_id, google_email, refresh_token_enc, scopes) values ($1, 'x@x', 'v1:x', '{}')", [c]);
  }
  id.leadA = await one("insert into painel.leads (poli_contact_uuid, name, company, phone_e164, hubspot_contact_id) values ('pa', 'Maria Souza', 'Empresa X', '+5562999991234', 'hs1') returning id");
  id.leadB = await one("insert into painel.leads (poli_contact_uuid, name, phone_e164) values ('pb', 'Maria Lima', '+5562988885678') returning id");
  await db.query("insert into painel.chats (poli_attendance_uuid, lead_id, sdr_id, opened_at, last_message_at) values ('ta', $1, $2, now(), now()), ('tb', $3, $4, now(), now())",
    [id.leadA, id.sdrA, id.leadB, id.sdrB]);
  id.car = await one("insert into painel.carousels (brand, name) values ('poli', 'T') returning id");
  await db.query("insert into painel.carousel_members (carousel_id, closer_id, weight) values ($1, $2, 1), ($1, $3, 1)", [id.car, id.closerA, id.closerB]);
  await db.query(`insert into auth.users (id) values ${Object.values(uid).map((u) => `('${u}')`).join(",")}`);
  await db.query(
    `insert into painel.profiles (id, name, role, sdr_id) values ($1, 'SDR A', 'sdr', $6), ($2, 'SDR B', 'sdr', $7),
       ($3, 'Closer A', 'closer', $8), ($4, 'Closer B', 'closer', $9), ($5, 'Gestor', 'gestor', null)`,
    [uid.sdrA, uid.sdrB, uid.closerA, uid.closerB, uid.gestor, id.sdrA, id.sdrB, id.closerA, id.closerB],
  );
  // reunião do lead A, agendada pelo SDR A
  const r = (await db.query<{ meeting_id: string; closer_id: string }>(
    "select * from painel.reservar_reuniao($1, $2, '2026-10-12T13:00:00Z', '2026-10-12T13:30:00Z', $3::uuid[], $4, $5)",
    [id.car, id.leadA, [id.closerA, id.closerB], id.sdrA, uid.sdrA],
  )).rows[0];
  id.meeting = r.meeting_id;
  id.meetingCloser = r.closer_id;
  await db.query("update painel.meetings set hubspot_contact_id = 'hs1', handoff = 'quer 8 usuários', lead_name = 'Maria Souza' where id = $1", [id.meeting]);
});

afterAll(async () => {
  await db.close();
});

describe("busca de lead", () => {
  it("SDR acha leads de todas as carteiras (nome ou final do telefone), como o gestor; closer não busca", async () => {
    expect((await as<{ name: string }>(uid.sdrA, "select name from painel.buscar_leads_para_agendar('maria')")).map((r) => r.name).sort()).toEqual(["Maria Lima", "Maria Souza"]);
    expect((await as<{ name: string; phone_final: string }>(uid.sdrB, "select name, phone_final from painel.buscar_leads_para_agendar('85678')"))).toEqual([{ name: "Maria Lima", phone_final: "5678" }]);
    expect((await as<{ name: string }>(uid.sdrB, "select name from painel.buscar_leads_para_agendar('Souza')")).map((r) => r.name)).toEqual(["Maria Souza"]);
    expect((await as(uid.gestor, "select * from painel.buscar_leads_para_agendar('maria')")).length).toBe(2);
    expect(await as(uid.gestor, "select * from painel.buscar_leads_para_agendar('m')")).toEqual([]);
    await expect(as(uid.closerA, "select * from painel.buscar_leads_para_agendar('maria')")).rejects.toThrow(/acesso negado/);
  });
});

describe("passagem de bastão e reuniões do lead", () => {
  it("abre para o closer da reunião, qualquer SDR e o gestor; nega o outro closer", async () => {
    const outroCloser = id.meetingCloser === id.closerA ? uid.closerB : uid.closerA;
    const closerDela = id.meetingCloser === id.closerA ? uid.closerA : uid.closerB;
    for (const u of [closerDela, uid.sdrA, uid.sdrB, uid.gestor]) {
      expect((await as<{ handoff: string }>(u, "select handoff from painel.reuniao_detalhe($1)", [id.meeting]))[0].handoff).toBe("quer 8 usuários");
    }
    await expect(as(outroCloser, "select * from painel.reuniao_detalhe($1)", [id.meeting])).rejects.toThrow(/acesso negado/);
  });

  it("reuniões do lead pelo lead ou pelo contato do HubSpot; closer não usa", async () => {
    expect(await as(uid.sdrB, "select id from painel.reunioes_do_lead(null, 'hs1')")).toEqual([{ id: id.meeting }]);
    expect(await as(uid.sdrA, "select id from painel.reunioes_do_lead($1, null)", [id.leadA])).toEqual([{ id: id.meeting }]);
    await expect(as(uid.closerA, "select * from painel.reunioes_do_lead($1, null)", [id.leadA])).rejects.toThrow(/acesso negado/);
  });
});

describe("plano B e lead preso", () => {
  it("lead do HubSpot sem chat: reaproveita o lead com esse contato, ou cria um sem contato da Poli", async () => {
    expect((await db.query<{ v: string }>("select painel.lead_para_agendar('hs1', 'x', null) as v")).rows[0].v).toBe(id.leadA);
    const novo = (await db.query<{ v: string }>("select painel.lead_para_agendar('hs9', 'Novo', 'Y') as v")).rows[0].v;
    expect((await db.query("select 1 from painel.leads where id = $1 and poli_contact_uuid is null and hubspot_contact_id = 'hs9'", [novo])).rows).toHaveLength(1);
  });

  it("outro registro de lead com o mesmo contato do HubSpot fica preso ao mesmo closer", async () => {
    const dup = await one("insert into painel.leads (poli_contact_uuid, hubspot_contact_id) values ('pdup', 'hs1') returning id");
    expect((await db.query<{ v: string }>("select painel.closer_preso($1, $2) as v", [id.car, dup])).rows[0].v).toBe(id.meetingCloser);
    const r = (await db.query<{ closer_id: string }>(
      "select * from painel.reservar_reuniao($1, $2, '2026-10-13T13:00:00Z', '2026-10-13T13:30:00Z', $3::uuid[])",
      [id.car, dup, [id.closerA, id.closerB]],
    )).rows[0];
    expect(r.closer_id).toBe(id.meetingCloser);
  });

  it("closer desconectado sai dos elegíveis; funções internas fechadas para usuário logado", async () => {
    await db.query("update painel.google_connections set status = 'desconectada' where closer_id = $1", [id.closerB]);
    expect((await db.query<{ closer_id: string }>("select * from painel.closers_elegiveis($1)", [id.car])).rows.map((r) => r.closer_id)).toEqual([id.closerA]);
    await db.query("update painel.google_connections set status = 'conectada' where closer_id = $1", [id.closerB]);
    for (const sql of ["select * from painel.closers_elegiveis($1)", "select painel.closer_preso($1, null)"]) {
      await expect(as(uid.gestor, sql, [id.car])).rejects.toThrow(/permission denied/);
    }
    await expect(as(uid.sdrA, "select painel.lead_para_agendar('hs7', 'x', null)")).rejects.toThrow(/permission denied/);
  });
});
