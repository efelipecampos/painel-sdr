// Fase 10b: carrossel (livro-caixa, escolha do closer, trava, lead preso, reagendar, trocas) com agenda simulada.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDb } from "./db";

let db: PGlite;
let n = 0;
const T0 = Date.parse("2026-10-12T12:00:00Z");
const slot = (i: number, minutes = 30) => [new Date(T0 + i * 3600_000).toISOString(), new Date(T0 + i * 3600_000 + minutes * 60_000).toISOString()];

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
    delete from painel.carousel_ledger; delete from painel.meeting_status_history; delete from painel.meetings;
    delete from painel.carousel_members; delete from painel.carousels;
  `);
});

async function closer(name: string): Promise<string> {
  return (await db.query<{ id: string }>(
    "insert into painel.sdrs (poli_email, name, role) values ($1, $2, 'closer') returning id", [`${name}${++n}@x`, name],
  )).rows[0].id;
}
async function carousel(members: [string, number][], name = "C"): Promise<string> {
  const id = (await db.query<{ id: string }>("insert into painel.carousels (brand, name) values ('poli', $1) returning id", [name])).rows[0].id;
  for (const [c, w] of members) await db.query("insert into painel.carousel_members (carousel_id, closer_id, weight) values ($1, $2, $3)", [id, c, w]);
  return id;
}
async function lead(): Promise<string> {
  return (await db.query<{ id: string }>("insert into painel.leads (poli_contact_uuid) values ($1) returning id", [`l${++n}`])).rows[0].id;
}
async function reservar(car: string, livres: string[], i: number, leadId?: string): Promise<{ meeting_id: string; closer_id: string }> {
  const [a, b] = slot(i);
  return (await db.query<{ meeting_id: string; closer_id: string }>(
    "select * from painel.reservar_reuniao($1, $2, $3, $4, $5::uuid[])", [car, leadId ?? (await lead()), a, b, livres],
  )).rows[0];
}
async function resumo(car: string) {
  const rows = (await db.query<{ closer_id: string; recebidas: string; esperado: string; saldo: string }>(
    "select * from painel.carrossel_resumo($1)", [car],
  )).rows;
  return Object.fromEntries(rows.map((r) => [r.closer_id, { recebidas: Number(r.recebidas), esperado: Number(r.esperado), saldo: Number(r.saldo) }]));
}

describe("distribuição por saldo", () => {
  it("200 reuniões com pesos 3/2/2/1 terminam com no máximo 1 de diferença da fatia", async () => {
    const [a, b, c, d] = [await closer("Ana"), await closer("Bia"), await closer("Caio"), await closer("Davi")];
    const car = await carousel([[a, 3], [b, 2], [c, 2], [d, 1]]);
    for (let i = 0; i < 200; i++) await reservar(car, [a, b, c, d], i);
    const r = await resumo(car);
    const esperado = { [a]: 75, [b]: 50, [c]: 50, [d]: 25 };
    for (const id of [a, b, c, d]) expect(Math.abs(r[id].recebidas - esperado[id])).toBeLessThanOrEqual(1);
  });

  it("closer pausado no meio não acumula crédito (não recebe uma rajada quando volta)", async () => {
    const [a, b] = [await closer("Ana"), await closer("Bia")];
    const car = await carousel([[a, 1], [b, 1]]);
    for (let i = 0; i < 10; i++) await reservar(car, [a, b], i);
    const antes = (await resumo(car))[b].esperado;
    await db.query("update painel.carousel_members set active = false where closer_id = $1", [b]);
    for (let i = 10; i < 20; i++) await reservar(car, [a, b], i);
    expect((await resumo(car))[b].esperado).toBe(antes);
    await db.query("update painel.carousel_members set active = true where closer_id = $1", [b]);
    const recebidasB = (await resumo(car))[b].recebidas;
    for (let i = 20; i < 30; i++) await reservar(car, [a, b], i);
    expect((await resumo(car))[b].recebidas - recebidasB).toBeLessThanOrEqual(6);
  });

  it("mudança de peso no meio não redistribui o passado", async () => {
    const [a, b] = [await closer("Ana"), await closer("Bia")];
    const car = await carousel([[a, 1], [b, 1]]);
    for (let i = 0; i < 10; i++) await reservar(car, [a, b], i);
    const credA = (await db.query<{ s: string }>("select sum(amount) as s from painel.carousel_ledger where closer_id = $1 and kind = 'credit'", [a])).rows[0].s;
    await db.query("update painel.carousel_members set weight = 3 where closer_id = $1", [a]);
    expect((await db.query<{ s: string }>("select sum(amount) as s from painel.carousel_ledger where closer_id = $1 and kind = 'credit'", [a])).rows[0].s).toBe(credA);
    for (let i = 10; i < 50; i++) await reservar(car, [a, b], i);
    const r = await resumo(car);
    expect(Math.abs(r[a].recebidas - 35)).toBeLessThanOrEqual(1); // 5 + 30
    expect(Math.abs(r[b].recebidas - 15)).toBeLessThanOrEqual(1); // 5 + 10
  });

  it("estorno de no show devolve a vez; voltar a situação desfaz o estorno", async () => {
    const [a, b] = [await closer("Ana"), await closer("Bia")];
    const car = await carousel([[a, 1], [b, 1]]);
    const m1 = await reservar(car, [a, b], 0);
    await reservar(car, [a, b], 1);
    await db.query("update painel.meetings set status = 'noshow' where id = $1", [m1.meeting_id]);
    expect((await reservar(car, [a, b], 2)).closer_id).toBe(m1.closer_id);
    // invalidada não devolve por padrão
    const m4 = await reservar(car, [a, b], 3);
    await db.query("update painel.meetings set status = 'invalidada' where id = $1", [m4.meeting_id]);
    expect((await db.query("select 1 from painel.carousel_ledger where meeting_id = $1 and kind = 'refund'", [m4.meeting_id])).rows).toHaveLength(0);
    // voltar de no show para validada desfaz o estorno
    await db.query("update painel.meetings set status = 'validada' where id = $1", [m1.meeting_id]);
    const net = (await db.query<{ s: string }>("select coalesce(sum(amount),0) as s from painel.carousel_ledger where meeting_id = $1 and kind = 'refund'", [m1.meeting_id])).rows[0].s;
    expect(Number(net)).toBe(0);
  });

  it("empate resolvido sempre do mesmo jeito (quem recebeu há mais tempo; depois ordem alfabética)", async () => {
    const [b, a, c] = [await closer("Bia"), await closer("Ana"), await closer("Caio")];
    const car = await carousel([[a, 1], [b, 1], [c, 1]]);
    const seq = [];
    for (let i = 0; i < 6; i++) seq.push((await reservar(car, [a, b, c], i)).closer_id);
    expect(seq).toEqual([a, b, c, a, b, c]);
  });
});

describe("agenda e concorrência", () => {
  it("o mesmo closer nunca recebe duas reuniões no mesmo horário (nem em carrosséis diferentes)", async () => {
    const [a, b] = [await closer("Ana"), await closer("Bia")];
    const c1 = await carousel([[a, 1], [b, 1]], "C1");
    const c2 = await carousel([[a, 1]], "C2");
    const r1 = await reservar(c1, [a, b], 0);
    const r2 = await reservar(c1, [a, b], 0);
    expect(r1.closer_id).not.toBe(r2.closer_id);
    await expect(reservar(c1, [a, b], 0)).rejects.toThrow(/nenhum closer livre/);
    await expect(reservar(c2, [a], 0)).rejects.toThrow(/nenhum closer livre/);
  });

  it("respeita o intervalo mínimo entre reuniões (15 min)", async () => {
    const a = await closer("Ana");
    const car = await carousel([[a, 1]]);
    const l1 = await lead();
    await db.query("select * from painel.reservar_reuniao($1, $2, '2026-10-12T12:00:00Z', '2026-10-12T12:30:00Z', $3::uuid[])", [car, l1, [a]]);
    await expect(db.query("select * from painel.reservar_reuniao($1, $2, '2026-10-12T12:40:00Z', '2026-10-12T13:10:00Z', $3::uuid[])", [car, await lead(), [a]])).rejects.toThrow(/nenhum closer livre/);
    await db.query("select * from painel.reservar_reuniao($1, $2, '2026-10-12T12:45:00Z', '2026-10-12T13:15:00Z', $3::uuid[])", [car, await lead(), [a]]);
  });

  it("closer ocupado no Google (fora de p_livres) não é escolhido", async () => {
    const [a, b] = [await closer("Ana"), await closer("Bia")];
    const car = await carousel([[a, 1], [b, 1]]);
    expect((await reservar(car, [b], 0)).closer_id).toBe(b);
  });
});

describe("lead preso ao mesmo closer", () => {
  it("nova reunião do mesmo lead em até 30 dias vai para o mesmo closer, mesmo com saldo menor", async () => {
    const [a, b] = [await closer("Ana"), await closer("Bia")];
    const car = await carousel([[a, 1], [b, 1]]);
    const l = await lead();
    const m1 = await reservar(car, [a, b], 0, l);
    await db.query("update painel.meetings set status = 'cancelada' where id = $1", [m1.meeting_id]);
    expect((await reservar(car, [a, b], 3, l)).closer_id).toBe(m1.closer_id);
  });

  it("se o closer do lead não está livre, não troca sozinho: avisa", async () => {
    const [a, b] = [await closer("Ana"), await closer("Bia")];
    const car = await carousel([[a, 1], [b, 1]]);
    const l = await lead();
    const m1 = await reservar(car, [a, b], 0, l);
    const outro = m1.closer_id === a ? b : a;
    await expect(reservar(car, [outro], 3, l)).rejects.toThrow(/closer deste lead não está livre/);
  });
});

describe("editar, reagendar e trocas", () => {
  it("reagendar mantém o closer quando ele está livre e reativa reunião cancelada", async () => {
    const [a, b] = [await closer("Ana"), await closer("Bia")];
    const car = await carousel([[a, 1], [b, 1]]);
    const m = await reservar(car, [a, b], 0);
    await db.query("update painel.meetings set status = 'cancelada' where id = $1", [m.meeting_id]);
    const [s, e] = slot(5);
    const r = (await db.query<{ closer_id: string; closer_mudou: boolean }>("select * from painel.reagendar_reuniao($1, $2, $3, $4::uuid[])", [m.meeting_id, s, e, [a, b]])).rows[0];
    expect(r).toEqual({ closer_id: m.closer_id, closer_mudou: false });
    const mm = (await db.query<{ status: string; starts_at: Date }>("select status::text, starts_at from painel.meetings where id = $1", [m.meeting_id])).rows[0];
    expect(mm.status).toBe("agendada");
    expect(new Date(mm.starts_at).toISOString()).toBe(new Date(s).toISOString());
    expect((await resumo(car))[m.closer_id].recebidas).toBe(1);
  });

  it("reagendar para horário em que o closer não está livre: carrossel escolhe outro e o livro-caixa acompanha", async () => {
    const [a, b] = [await closer("Ana"), await closer("Bia")];
    const car = await carousel([[a, 1], [b, 1]]);
    const m = await reservar(car, [a, b], 0);
    const outro = m.closer_id === a ? b : a;
    const [s, e] = slot(5);
    const r = (await db.query<{ closer_id: string; closer_mudou: boolean }>("select * from painel.reagendar_reuniao($1, $2, $3, $4::uuid[])", [m.meeting_id, s, e, [outro]])).rows[0];
    expect(r).toEqual({ closer_id: outro, closer_mudou: true });
    const res = await resumo(car);
    expect([res[m.closer_id].recebidas, res[outro].recebidas]).toEqual([0, 1]);
    expect(res[a].esperado + res[b].esperado).toBeCloseTo(1, 5); // os créditos não duplicam
  });

  it("trocar closer (gestor) exige o novo livre e move o débito", async () => {
    const [a, b] = [await closer("Ana"), await closer("Bia")];
    const car = await carousel([[a, 1], [b, 1]]);
    const m = await reservar(car, [a, b], 0);
    const outro = m.closer_id === a ? b : a;
    await expect(db.query("select painel.trocar_closer($1, $2, $3::uuid[], 'x')", [m.meeting_id, outro, []])).rejects.toThrow(/não está livre/);
    await db.query("select painel.trocar_closer($1, $2, $3::uuid[], 'lead pediu')", [m.meeting_id, outro, [outro]]);
    const res = await resumo(car);
    expect([res[m.closer_id].recebidas, res[outro].recebidas]).toEqual([0, 1]);
    expect((await db.query<{ assigned_by: string; override_reason: string }>("select assigned_by, override_reason from painel.meetings where id = $1", [m.meeting_id])).rows[0])
      .toEqual({ assigned_by: "manual", override_reason: "lead pediu" });
  });

  it("passar para outra marca move a reunião e o débito para o outro carrossel", async () => {
    const a = await closer("Ana");
    const poli = await carousel([[a, 1]], "Poli 6-10");
    const ch = await carousel([[a, 1]], "CH 6-10");
    const m = await reservar(poli, [a], 0);
    await db.query("select painel.trocar_carrossel($1, $2)", [m.meeting_id, ch]);
    expect([(await resumo(poli))[a].recebidas, (await resumo(ch))[a].recebidas]).toEqual([0, 1]);
    // no show depois da troca devolve a vez no carrossel novo
    await db.query("update painel.meetings set status = 'noshow' where id = $1", [m.meeting_id]);
    expect((await resumo(ch))[a].recebidas).toBe(0);
  });

  it("desfazer reserva (falha no Google) apaga a reunião e os lançamentos", async () => {
    const a = await closer("Ana");
    const car = await carousel([[a, 1]]);
    const m = await reservar(car, [a], 0);
    await db.query("select painel.desfazer_reserva($1)", [m.meeting_id]);
    expect((await db.query("select 1 from painel.meetings where id = $1", [m.meeting_id])).rows).toHaveLength(0);
    expect((await db.query("select 1 from painel.carousel_ledger where meeting_id = $1", [m.meeting_id])).rows).toHaveLength(0);
  });
});

describe("acesso", () => {
  const sdrUser = "00000000-0000-0000-0000-0000000001a1";
  const gestorUser = "00000000-0000-0000-0000-0000000001a2";
  async function as(user: string, sql: string, params: unknown[] = []) {
    await db.exec(`select set_config('request.jwt.claims', '{"role":"authenticated"}', false);
                   select set_config('request.jwt.claim.sub', '${user}', false); set role authenticated;`);
    try { return (await db.query<Record<string, unknown>>(sql, params)).rows; } finally {
      await db.exec(`reset role; select set_config('request.jwt.claims', '{"role":"service_role"}', false); select set_config('request.jwt.claim.sub', '', false);`);
    }
  }
  beforeAll(async () => {
    await db.exec(`select set_config('request.jwt.claims', '{"role":"service_role"}', false);`);
    const s = (await db.query<{ id: string }>("insert into painel.sdrs (poli_email, name, role) values ('sdr-acesso@x', 'SDR', 'sdr') returning id")).rows[0].id;
    await db.exec(`insert into auth.users (id) values ('${sdrUser}'), ('${gestorUser}');`);
    await db.query("insert into painel.profiles (id, name, role, sdr_id) values ($1, 'SDR', 'sdr', $2), ($3, 'Gestor', 'gestor', null)", [sdrUser, s, gestorUser]);
  });

  it("SDR: não reserva, não vê resumo, não lê carrosséis nem closers; a lista para agendar não identifica closer", async () => {
    const a = await closer("Ana");
    const car = await carousel([[a, 1]]);
    const l = await lead();
    const [s, e] = slot(0);
    await expect(as(sdrUser, "select * from painel.reservar_reuniao($1, $2, $3, $4, $5::uuid[])", [car, l, s, e, [a]])).rejects.toThrow(/permission denied/);
    await expect(as(sdrUser, "select * from painel.reagendar_reuniao($1, $2, $3, $4::uuid[])", [car, s, e, [a]])).rejects.toThrow(/permission denied/);
    await expect(as(sdrUser, "select * from painel.carrossel_resumo($1)", [car])).rejects.toThrow(/acesso negado/);
    expect(await as(sdrUser, "select * from painel.carousels")).toEqual([]);
    expect(await as(sdrUser, "select * from painel.carousel_members")).toEqual([]);
    await expect(as(sdrUser, "select * from painel.carousel_ledger")).rejects.toThrow(/permission denied/);
    const lista = await as(sdrUser, "select * from painel.carrosseis_para_agendar()");
    expect(lista).toHaveLength(1);
    expect(Object.keys(lista[0]).sort()).toEqual(["brand", "description", "durations", "id", "name"]);
    expect(JSON.stringify(lista)).not.toContain(a);
  });

  it("SDR não altera peso; gestor altera e fica registrado quem mudou", async () => {
    const a = await closer("Ana");
    const car = await carousel([[a, 1]]);
    await as(sdrUser, "update painel.carousel_members set weight = 9 where carousel_id = $1", [car]);
    expect((await db.query<{ w: number }>("select weight as w from painel.carousel_members where carousel_id = $1", [car])).rows[0].w).toBe(1);
    await as(gestorUser, "update painel.carousel_members set weight = 3 where carousel_id = $1", [car]);
    expect((await db.query<{ w: number; u: string }>("select weight as w, updated_by as u from painel.carousel_members where carousel_id = $1", [car])).rows[0])
      .toEqual({ w: 3, u: gestorUser });
    expect((await as(gestorUser, "select * from painel.carrossel_resumo($1)", [car]))).toHaveLength(1);
  });
});
