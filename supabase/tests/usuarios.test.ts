// Tela Usuários: só o admin e quem tem a marcação desativam; desativar tira o acesso e as listas, sem apagar
// dados; a soma do time continua contando quem saiu. Remover closer de carrossel: só gestor/admin.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDb } from "./db";

let db: PGlite;
const uid = {
  admin: "00000000-0000-0000-0000-0000000002a1",
  timoteo: "00000000-0000-0000-0000-0000000002a2",
  iago: "00000000-0000-0000-0000-0000000002a3",
  sdrA: "00000000-0000-0000-0000-0000000002a4",
};
const sdr: Record<string, string> = {};
const FROM = "2026-10-05T03:00:00Z";
const TO = "2026-10-06T03:00:00Z";
const SEP = ["2026-09-01T03:00:00Z", "2026-10-01T03:00:00Z"];

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

beforeAll(async () => {
  db = await createTestDb();
  await db.exec(`select set_config('request.jwt.claims', '{"role":"service_role"}', false);`);
  for (const k of ["A", "B"]) {
    sdr[k] = (await db.query<{ id: string }>(
      "insert into painel.sdrs (poli_email, name, role) values ($1, $2, 'sdr') returning id", [`${k.toLowerCase()}@poli.digital`, `SDR ${k}`],
    )).rows[0].id;
    const lead = (await db.query<{ id: string }>("insert into painel.leads (poli_contact_uuid) values ($1) returning id", [`c${k}`])).rows[0].id;
    const chat = (await db.query<{ id: string }>(
      "insert into painel.chats (poli_attendance_uuid, lead_id, sdr_id, opened_at) values ($1, $2, $3, '2026-09-10T12:00:00Z') returning id", [`a${k}`, lead, sdr[k]],
    )).rows[0].id;
    await db.query(
      `insert into painel.chat_messages (poli_message_id, chat_id, lead_id, sdr_id, sender, sent_at, by_human) values
         ($1, $2, $3, $4, 'template', '2026-09-10T12:00:00Z', true)`, [`m${k}`, chat, lead, sdr[k]],
    );
  }
  sdr.gestor = (await db.query<{ id: string }>("insert into painel.sdrs (poli_email, name, role) values ('timoteo.luis@poli.digital', 'Timóteo (Poli)', 'gestor') returning id")).rows[0].id;
  sdr.closer = (await db.query<{ id: string }>("insert into painel.sdrs (poli_email, name, role) values ('ana@poli.digital', 'Ana', 'closer') returning id")).rows[0].id;
  await db.query(`insert into auth.users (id, email) values ($1, 'felipe@poli.digital'), ($2, 'Timoteo.Luis@poli.digital'), ($3, 'iago@poli.digital'), ($4, 'a@poli.digital')`,
    [uid.admin, uid.timoteo, uid.iago, uid.sdrA]);
  await db.query(
    `insert into painel.profiles (id, name, role, sdr_id, can_manage_users) values
       ($1, 'Felipe', 'admin', null, false), ($2, 'Timóteo', 'gestor', null, true), ($3, 'Iago', 'gestor', null, false), ($4, 'SDR A', 'sdr', $5, false)`,
    [uid.admin, uid.timoteo, uid.iago, uid.sdrA, sdr.A],
  );
});

afterAll(async () => {
  await db.close();
});

describe("quem gerencia usuários", () => {
  it("admin e Timóteo listam; Iago (gestor sem marcação) e SDR: acesso negado", async () => {
    expect((await as(uid.admin, "select * from painel.usuarios()")).length).toBeGreaterThan(0);
    expect((await as(uid.timoteo, "select * from painel.usuarios()")).length).toBeGreaterThan(0);
    for (const u of [uid.iago, uid.sdrA]) {
      await expect(as(u, "select * from painel.usuarios()")).rejects.toThrow(/acesso negado/);
      await expect(as(u, "select painel.definir_usuario_ativo($1, null, false)", [sdr.B])).rejects.toThrow(/acesso negado/);
    }
  });

  it("uma linha por pessoa: atendente e login juntos (pelo sdr_id ou pelo e-mail)", async () => {
    const rows = await as<{ sdr_id: string | null; profile_id: string | null; name: string; papel: string; tem_login: boolean }>(uid.admin, "select * from painel.usuarios()");
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(byName["SDR A"]).toMatchObject({ sdr_id: sdr.A, profile_id: uid.sdrA, papel: "sdr", tem_login: true });
    expect(byName["Timóteo"]).toMatchObject({ sdr_id: sdr.gestor, profile_id: uid.timoteo, papel: "gestor", tem_login: true });
    expect(byName["SDR B"]).toMatchObject({ profile_id: null, tem_login: false });
    expect(byName["Felipe"]).toMatchObject({ sdr_id: null, profile_id: uid.admin, papel: "admin" });
    expect(rows).toHaveLength(6); // A, B, Timóteo, Ana, Felipe, Iago
  });

  it("não desativa a si mesmo nem o administrador", async () => {
    await expect(as(uid.timoteo, "select painel.definir_usuario_ativo($1, $2, false)", [sdr.gestor, uid.timoteo])).rejects.toThrow(/próprio usuário/);
    await expect(as(uid.timoteo, "select painel.definir_usuario_ativo(null, $1, false)", [uid.admin])).rejects.toThrow(/administrador/);
  });
});

describe("desativar", () => {
  it("SDR desativado perde o acesso na hora; os dados ficam", async () => {
    expect((await as(uid.sdrA, "select * from painel.sdr_metrics($1, $2)", [FROM, TO])).length).toBe(1);
    await as(uid.timoteo, "select painel.definir_usuario_ativo($1, $2, false)", [sdr.A, uid.sdrA]);
    await expect(as(uid.sdrA, "select * from painel.sdr_metrics($1, $2)", [FROM, TO])).rejects.toThrow(/acesso negado/);
    expect((await db.query("select 1 from painel.chat_messages where sdr_id = $1", [sdr.A])).rows).toHaveLength(1);
    expect((await db.query("select 1 from painel.profiles where id = $1", [uid.sdrA])).rows).toHaveLength(1);
  });

  it("some da lista de SDRs onde não teve atividade, aparece no período em que teve; a soma do time não muda", async () => {
    const hoje = await as<{ name: string }>(uid.admin, "select name from painel.sdr_metrics($1, $2)", [FROM, TO]);
    expect(hoje.map((r) => r.name)).toEqual(["SDR B"]);
    const set = await as<{ name: string }>(uid.admin, "select name from painel.sdr_metrics($1, $2)", SEP);
    expect(set.map((r) => r.name)).toEqual(["SDR A", "SDR B"]);
    const time = (await as<{ sdrs: number; leads_abordados: number }>(uid.admin, "select sdrs, leads_abordados from painel.team_metrics($1, $2)", SEP))[0];
    expect(time).toEqual({ sdrs: 2, leads_abordados: 2 });
    expect((await as<{ sdrs: number }>(uid.admin, "select sdrs from painel.team_metrics($1, $2)", [FROM, TO]))[0].sdrs).toBe(1);
  });

  it("closer desativado sai da lista de closers e não recebe reunião", async () => {
    const car = (await db.query<{ id: string }>("insert into painel.carousels (brand, name) values ('poli', 'T') returning id")).rows[0].id;
    await db.query("insert into painel.carousel_members (carousel_id, closer_id, weight) values ($1, $2, 1)", [car, sdr.closer]);
    await as(uid.admin, "select painel.definir_usuario_ativo($1, null, false)", [sdr.closer]);
    expect((await as<{ id: string }>(uid.admin, "select id from painel.closers_para_carrossel()")).map((r) => r.id)).not.toContain(sdr.closer);
    const lead = (await db.query<{ id: string }>("insert into painel.leads (poli_contact_uuid) values ('cx') returning id")).rows[0].id;
    await expect(db.query("select * from painel.reservar_reuniao($1, $2, '2026-10-12T12:00:00Z', '2026-10-12T12:30:00Z', $3::uuid[])", [car, lead, [sdr.closer]]))
      .rejects.toThrow(/nenhum closer livre/);
  });

  it("reativar devolve o acesso", async () => {
    await as(uid.admin, "select painel.definir_usuario_ativo($1, $2, true)", [sdr.A, uid.sdrA]);
    expect((await as(uid.sdrA, "select * from painel.sdr_metrics($1, $2)", [FROM, TO])).length).toBe(1);
  });
});

describe("remover closer do carrossel", () => {
  it("gestor remove; SDR não; o livro-caixa continua", async () => {
    const car = (await db.query<{ id: string }>("insert into painel.carousels (brand, name) values ('poli', 'R') returning id")).rows[0].id;
    await db.query("insert into painel.carousel_members (carousel_id, closer_id, weight) values ($1, $2, 1)", [car, sdr.A]);
    await db.query("insert into painel.carousel_ledger (carousel_id, closer_id, kind, amount, period_key) values ($1, $2, 'credit', 1, '2026-10')", [car, sdr.A]);
    await as(uid.sdrA, "delete from painel.carousel_members where carousel_id = $1", [car]);
    expect((await db.query("select 1 from painel.carousel_members where carousel_id = $1", [car])).rows).toHaveLength(1);
    await as(uid.iago, "delete from painel.carousel_members where carousel_id = $1", [car]);
    expect((await db.query("select 1 from painel.carousel_members where carousel_id = $1", [car])).rows).toHaveLength(0);
    expect((await db.query("select 1 from painel.carousel_ledger where carousel_id = $1", [car])).rows).toHaveLength(1);
  });
});
