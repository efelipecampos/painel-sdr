// Fase 10e.2: pedido de troca de closer, troca pelo carrossel, expiração, troca de marca e relatório.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDb } from "./db";

let db: PGlite;
const uid = { sdrA: "00000000-0000-0000-0000-0000000006a1", sdrB: "00000000-0000-0000-0000-0000000006a2", gestor: "00000000-0000-0000-0000-0000000006a3", closer: "00000000-0000-0000-0000-0000000006a4" };
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
async function reunir(starts: string, sdr = id.sdrA, by = uid.sdrA) {
  const lead = await one("insert into painel.leads (poli_contact_uuid) values ($1) returning id", [`l${starts}${Math.random()}`]);
  const ends = new Date(Date.parse(starts) + 30 * 60_000).toISOString();
  return (await db.query<{ meeting_id: string; closer_id: string }>(
    "select * from painel.reservar_reuniao($1, $2, $3, $4, $5::uuid[], $6, $7)", [id.car, lead, starts, ends, [id.c1, id.c2, id.c3], sdr, by],
  )).rows[0];
}

beforeAll(async () => {
  db = await createTestDb();
  await db.exec(`select set_config('request.jwt.claims', '{"role":"service_role"}', false);`);
  id.sdrA = await one("insert into painel.sdrs (poli_email, name, role) values ('a@x', 'SDR A', 'sdr') returning id");
  id.sdrB = await one("insert into painel.sdrs (poli_email, name, role) values ('b@x', 'SDR B', 'sdr') returning id");
  for (const k of ["c1", "c2", "c3"]) {
    id[k] = await one("insert into painel.sdrs (poli_email, name, role) values ($1, $2, 'closer') returning id", [`${k}@x`, k]);
    await db.query("insert into painel.google_connections (closer_id, google_email, refresh_token_enc, scopes) values ($1, 'x@x', 'v1:x', '{}')", [id[k]]);
  }
  await db.query(`insert into auth.users (id) values ${Object.values(uid).map((u) => `('${u}')`).join(",")}`);
  await db.query("insert into painel.profiles (id, name, role, sdr_id) values ($1, 'SDR A', 'sdr', $4), ($2, 'SDR B', 'sdr', $5), ($3, 'G', 'gestor', null), ($6, 'C1', 'closer', $7)",
    [uid.sdrA, uid.sdrB, uid.gestor, id.sdrA, id.sdrB, uid.closer, id.c1]);
  id.car = await one("select id from painel.carousels where brand = 'poli' and name = 'Clientes até 5 usuários'");
  for (const k of ["c1", "c2", "c3"]) await db.query("insert into painel.carousel_members (carousel_id, closer_id, weight) values ($1, $2, 1)", [id.car, id[k]]);
});

afterAll(async () => {
  await db.close();
});

describe("pedido de troca", () => {
  it("qualquer SDR pede, com justificativa; gestor não pede; um pendente por reunião; gestor e SDRs veem todos", async () => {
    const m = await reunir("2030-01-07T13:00:00Z");
    id.m1 = m.meeting_id;
    await expect(as(uid.gestor, "select painel.pedir_troca_closer($1, 'x')", [m.meeting_id])).rejects.toThrow(/acesso negado/);
    await expect(as(uid.sdrA, "select painel.pedir_troca_closer($1, '  ')", [m.meeting_id])).rejects.toThrow(/justificativa/);
    await as(uid.sdrA, "select painel.pedir_troca_closer($1, 'lead pediu outro horário com outra pessoa')", [m.meeting_id]);
    await expect(as(uid.sdrA, "select painel.pedir_troca_closer($1, 'de novo')", [m.meeting_id])).rejects.toThrow(/já existe um pedido/);
    await expect(as(uid.sdrB, "select painel.pedir_troca_closer($1, 'outro SDR')", [m.meeting_id])).rejects.toThrow(/já existe um pedido/);
    expect(await as(uid.gestor, "select id from painel.pedidos_troca()")).toHaveLength(1);
    expect(await as(uid.sdrA, "select id from painel.pedidos_troca()")).toHaveLength(1);
    expect(await as(uid.sdrB, "select id from painel.pedidos_troca()")).toHaveLength(1);
    await expect(as(uid.closer, "select * from painel.pedidos_troca()")).rejects.toThrow(/acesso negado/);
    await expect(as(uid.gestor, "select * from painel.closer_swap_requests")).rejects.toThrow(/permission denied/);
  });

  it("troca pelo carrossel nunca devolve o mesmo closer e move o débito", async () => {
    const before = (await db.query<{ closer_id: string }>("select closer_id from painel.meetings where id = $1", [id.m1])).rows[0].closer_id;
    const novo = (await db.query<{ v: string }>("select painel.trocar_closer_carrossel($1, $2::uuid[], 'aprovado') as v", [id.m1, [id.c1, id.c2, id.c3]])).rows[0].v;
    expect(novo).not.toBe(before);
    const deb = (await db.query<{ closer_id: string; s: string }>("select closer_id, sum(amount) as s from painel.carousel_ledger where meeting_id = $1 and kind = 'debit' group by closer_id", [id.m1])).rows;
    expect(Object.fromEntries(deb.map((d) => [d.closer_id, Number(d.s)]))).toMatchObject({ [before]: 0, [novo]: 1 });
    await expect(db.query("select painel.trocar_closer_carrossel($1, $2::uuid[], 'x')", [id.m1, [novo]])).rejects.toThrow(/nenhum outro closer livre/);
  });

  it("pedido de reunião que começa em menos de 2 h expira", async () => {
    const soon = new Date(Date.now() + 60 * 60_000).toISOString();
    const lead = await one("insert into painel.leads (poli_contact_uuid) values ('soon') returning id");
    const m = (await db.query<{ meeting_id: string }>("select * from painel.reservar_reuniao($1, $2, $3, $4, $5::uuid[], $6, $7)",
      [id.car, lead, soon, new Date(Date.parse(soon) + 1800_000).toISOString(), [id.c1, id.c2, id.c3], id.sdrA, uid.sdrA])).rows[0];
    await as(uid.sdrA, "select painel.pedir_troca_closer($1, 'motivo')", [m.meeting_id]);
    expect((await db.query<{ n: number }>("select painel.expirar_pedidos_troca() as n")).rows[0].n).toBe(1);
    expect((await db.query<{ s: string }>("select status as s from painel.closer_swap_requests where meeting_id = $1", [m.meeting_id])).rows[0].s).toBe("expirado");
  });
});

describe("troca de marca", () => {
  it("vai para o carrossel de mesmo porte na outra marca; Licitação não tem equivalente", async () => {
    const ch = await one("select id from painel.carousels where brand = 'chatshub' and name = 'Clientes até 5 usuários'");
    expect((await db.query<{ v: string }>("select painel.carrossel_outra_marca($1) as v", [id.car])).rows[0].v).toBe(ch);
    expect((await db.query<{ v: string }>("select painel.carrossel_outra_marca($1) as v", [ch])).rows[0].v).toBe(id.car);
    const lic = await one("select id from painel.carousels where name = 'Licitação'");
    expect((await db.query<{ v: string | null }>("select painel.carrossel_outra_marca($1) as v", [lic])).rows[0].v).toBeNull();
    // só o servidor chama (revisão de segurança da Fase 8): usuário logado não executa
    await expect(as(uid.gestor, "select painel.carrossel_outra_marca($1)", [id.car])).rejects.toThrow(/permission denied/);
  });
});

describe("relatório", () => {
  it("cancelada e reagendada em até 1 h contam; pedidos por SDR; só gestor vê", async () => {
    const m = await reunir("2030-01-08T13:00:00Z");
    await as(uid.sdrA, "select painel.definir_status_reuniao($1, 'cancelada')", [m.meeting_id]);
    const m2 = await reunir("2030-01-08T15:00:00Z");
    await db.query("insert into painel.meeting_changes (meeting_id, from_starts, to_starts) values ($1, now(), now())", [m2.meeting_id]);
    const r = (await as<{ sdr: string; agendadas: number; canceladas_1h: number; reagendadas_1h: number; pedidos: number; aprovados: number }>(
      uid.gestor, "select * from painel.relatorio_agendamentos('2000-01-01', '2100-01-01')"))[0];
    expect(r).toMatchObject({ sdr: "SDR A", agendadas: 4, canceladas_1h: 1, reagendadas_1h: 1, pedidos: 2 });
    await expect(as(uid.sdrA, "select * from painel.relatorio_agendamentos('2000-01-01', '2100-01-01')")).rejects.toThrow(/acesso negado/);
  });
});

describe("edição livre (gestor e admin, 2026-10-13)", () => {
  const debitos = async (m: string) => Object.fromEntries((await db.query<{ closer_id: string; s: string }>(
    "select closer_id, sum(amount) as s from painel.carousel_ledger where meeting_id = $1 and kind = 'debit' group by closer_id", [m])).rows.map((d) => [d.closer_id, Number(d.s)]));

  it("muda o horário (inclusive para o passado) mantendo o closer, mesmo sobreposto a outra reunião dele", async () => {
    const a = await reunir("2030-02-04T19:00:00Z");
    const b = await reunir("2030-02-04T17:00:00Z");
    if (b.closer_id !== a.closer_id) await db.query("update painel.meetings set closer_id = $2 where id = $1", [b.meeting_id, a.closer_id]);
    const mudou = (await db.query<{ v: boolean }>("select painel.editar_reuniao_livre($1, $2, $3, $4, null) as v",
      [a.meeting_id, "2030-02-04T17:15:00Z", "2030-02-04T18:15:00Z", a.closer_id])).rows[0].v;
    expect(mudou).toBe(false);
    const m = (await db.query<{ starts_at: Date; ends_at: Date; closer_id: string }>("select starts_at, ends_at, closer_id from painel.meetings where id = $1", [a.meeting_id])).rows[0];
    expect([m.starts_at.toISOString(), m.ends_at.toISOString(), m.closer_id]).toEqual(["2030-02-04T17:15:00.000Z", "2030-02-04T18:15:00.000Z", a.closer_id]);
    await db.query("select painel.editar_reuniao_livre($1, $2, $3, $4, null)", [a.meeting_id, "2020-01-04T10:00:00Z", "2020-01-04T10:30:00Z", a.closer_id]);
    expect((await db.query<{ starts_at: Date }>("select starts_at from painel.meetings where id = $1", [a.meeting_id])).rows[0].starts_at.toISOString()).toBe("2020-01-04T10:00:00.000Z");
  });

  it("troca para o closer escolhido sem checar agenda, marca manual e move o débito; cancelada volta a agendada", async () => {
    const a = await reunir("2030-02-05T13:00:00Z");
    const outro = [id.c1, id.c2, id.c3].find((c) => c !== a.closer_id)!;
    await db.query("update painel.meetings set status = 'cancelada' where id = $1", [a.meeting_id]);
    const mudou = (await db.query<{ v: boolean }>("select painel.editar_reuniao_livre($1, $2, $3, $4, ' lead pediu ') as v",
      [a.meeting_id, "2030-02-05T13:30:00Z", "2030-02-05T14:00:00Z", outro])).rows[0].v;
    expect(mudou).toBe(true);
    expect((await db.query("select closer_id, assigned_by, override_reason, status from painel.meetings where id = $1", [a.meeting_id])).rows[0])
      .toMatchObject({ closer_id: outro, assigned_by: "manual", override_reason: "lead pediu", status: "agendada" });
    expect(await debitos(a.meeting_id)).toMatchObject({ [a.closer_id]: 0, [outro]: 1 });
  });

  it("closer fora do carrossel ou sem agenda conectada não entra; horário invertido não passa", async () => {
    const a = await reunir("2030-02-06T13:00:00Z");
    const fora = await one("insert into painel.sdrs (poli_email, name, role) values ('fora@x', 'Fora', 'closer') returning id");
    await expect(db.query("select painel.editar_reuniao_livre($1, $2, $3, $4, null)", [a.meeting_id, "2030-02-06T14:00:00Z", "2030-02-06T14:30:00Z", fora])).rejects.toThrow(/não é do carrossel/);
    const outro = [id.c1, id.c2, id.c3].find((c) => c !== a.closer_id)!;
    await db.query("update painel.google_connections set status = 'desconectada' where closer_id = $1", [outro]);
    await expect(db.query("select painel.editar_reuniao_livre($1, $2, $3, $4, null)", [a.meeting_id, "2030-02-06T14:00:00Z", "2030-02-06T14:30:00Z", outro])).rejects.toThrow(/agenda conectada/);
    await db.query("update painel.google_connections set status = 'conectada' where closer_id = $1", [outro]);
    await expect(db.query("select painel.editar_reuniao_livre($1, $2, $3, $4, null)", [a.meeting_id, "2030-02-06T14:00:00Z", "2030-02-06T13:30:00Z", a.closer_id])).rejects.toThrow(/horário inválido/);
  });

  it("usuário logado (até gestor) não chama direto: só o servidor", async () => {
    const a = await reunir("2030-02-07T13:00:00Z");
    for (const u of [uid.gestor, uid.sdrA, uid.closer]) {
      await expect(as(u, "select painel.editar_reuniao_livre($1, $2, $3, $4, null)", [a.meeting_id, "2030-02-07T14:00:00Z", "2030-02-07T14:30:00Z", a.closer_id])).rejects.toThrow(/permission denied/);
    }
  });
});
