// Fase 10d.2: tela Reuniões e status. Cada um vê só o que é dele; o SDR só confirma cancelamento; o estorno
// do carrossel acompanha o status; tudo fica no histórico.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDb } from "./db";

let db: PGlite;
const uid = {
  sdrA: "00000000-0000-0000-0000-0000000005a1", sdrB: "00000000-0000-0000-0000-0000000005a2",
  closerA: "00000000-0000-0000-0000-0000000005a3", closerB: "00000000-0000-0000-0000-0000000005a4",
  gestor: "00000000-0000-0000-0000-0000000005a5",
};
const id: Record<string, string> = {};
const FROM = "2026-10-01T00:00:00Z";
const TO = "2026-11-01T00:00:00Z";

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
  for (const [k, role] of [["sdrA", "sdr"], ["sdrB", "sdr"], ["closerA", "closer"], ["closerB", "closer"]] as const) {
    id[k] = await one("insert into painel.sdrs (poli_email, name, role) values ($1, $2, $3) returning id", [`${k}@x`, k, role]);
  }
  for (const c of [id.closerA, id.closerB]) {
    await db.query("insert into painel.google_connections (closer_id, google_email, refresh_token_enc, scopes) values ($1, 'x@x', 'v1:x', '{}')", [c]);
  }
  await db.query(`insert into auth.users (id) values ${Object.values(uid).map((u) => `('${u}')`).join(",")}`);
  await db.query(
    `insert into painel.profiles (id, name, role, sdr_id) values ($1, 'A', 'sdr', $6), ($2, 'B', 'sdr', $7),
       ($3, 'CA', 'closer', $8), ($4, 'CB', 'closer', $9), ($5, 'G', 'gestor', null)`,
    [uid.sdrA, uid.sdrB, uid.closerA, uid.closerB, uid.gestor, id.sdrA, id.sdrB, id.closerA, id.closerB],
  );
  id.car = await one("insert into painel.carousels (brand, name) values ('poli', 'T') returning id");
  await db.query("insert into painel.carousel_members (carousel_id, closer_id, weight) values ($1, $2, 1)", [id.car, id.closerA]);
  const lead = await one("insert into painel.leads (poli_contact_uuid) values ('l1') returning id");
  id.m = (await db.query<{ meeting_id: string }>(
    "select * from painel.reservar_reuniao($1, $2, '2026-10-12T13:00:00Z', '2026-10-12T13:30:00Z', $3::uuid[], $4, $5)",
    [id.car, lead, [id.closerA], id.sdrA, uid.sdrA],
  )).rows[0].meeting_id;
});

afterAll(async () => {
  await db.close();
});

describe("quem vê", () => {
  it("qualquer SDR, o closer dela e o gestor veem; outro closer não", async () => {
    for (const u of [uid.sdrA, uid.sdrB, uid.closerA, uid.gestor]) {
      expect((await as<{ id: string }>(u, "select id from painel.reunioes_lista($1, $2)", [FROM, TO])).map((r) => r.id)).toEqual([id.m]);
    }
    expect(await as(uid.closerB, "select id from painel.reunioes_lista($1, $2)", [FROM, TO])).toEqual([]);
    expect((await as<{ p: string }>(uid.sdrB, "select painel.permissao_reuniao($1) as p", [id.m]))[0].p).toBe("sdr");
    expect((await as<{ p: string }>(uid.closerA, "select painel.permissao_reuniao($1) as p", [id.m]))[0].p).toBe("closer");
    expect((await as<{ p: string | null }>(uid.closerB, "select painel.permissao_reuniao($1) as p", [id.m]))[0].p).toBeNull();
  });
});

describe("status", () => {
  it("qualquer SDR marca qualquer status, inclusive na reunião de outro SDR; outro closer não mexe", async () => {
    for (const st of ["validada", "noshow", "invalidada", "agendada"]) {
      await as(uid.sdrB, "select painel.definir_status_reuniao($1, $2)", [id.m, st]);
    }
    await expect(as(uid.closerB, "select painel.definir_status_reuniao($1, 'noshow')", [id.m])).rejects.toThrow(/acesso negado/);
    await db.query("delete from painel.meeting_status_history where meeting_id = $1", [id.m]);
  });

  it("cancelada devolve a vez; o closer marca validada e o estorno sai; histórico guarda tudo", async () => {
    expect((await as<{ o: string }>(uid.sdrA, "select painel.definir_status_reuniao($1, 'cancelada') as o", [id.m]))[0].o).toBe("agendada");
    const refund = async () => Number((await db.query<{ s: string }>("select coalesce(sum(amount),0) as s from painel.carousel_ledger where meeting_id = $1 and kind = 'refund'", [id.m])).rows[0].s);
    expect(await refund()).toBe(1);
    await as(uid.closerA, "select painel.definir_status_reuniao($1, 'validada')", [id.m]);
    expect(await refund()).toBe(0);
    const h = (await db.query<{ f: string; t: string }>("select from_status::text as f, to_status::text as t from painel.meeting_status_history where meeting_id = $1 order by id", [id.m])).rows;
    expect(h).toEqual([{ f: "agendada", t: "cancelada" }, { f: "cancelada", t: "validada" }]);
  });

  it("histórico de mudanças: só o servidor lê", async () => {
    await expect(as(uid.gestor, "select * from painel.meeting_changes")).rejects.toThrow(/permission denied/);
  });
});
