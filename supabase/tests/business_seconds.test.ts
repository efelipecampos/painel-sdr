import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDb } from "./db";

// Horário padrão das migrations: seg–sex 08:00–18:00, fuso America/Sao_Paulo (-03).
// Datas de referência: 02/10/2026 é sexta; 05/10/2026 é segunda; 12/10/2026 é segunda.

let db: PGlite;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec(`
    delete from painel.holidays;
    update painel.settings set value = 'true' where key = 'holidays_off';
  `);
});

async function businessSeconds(from: string, to: string): Promise<number> {
  const res = await db.query<{ s: number }>(
    "select painel.business_seconds($1::timestamptz, $2::timestamptz) as s",
    [from, to],
  );
  return res.rows[0].s;
}

const HOUR = 3600;

describe("business_seconds", () => {
  it("intervalo inteiro dentro do expediente", async () => {
    expect(await businessSeconds("2026-10-05 09:00-03", "2026-10-05 10:30-03")).toBe(1.5 * HOUR);
  });

  it("intervalo atravessando a noite conta só o fim de um dia e o começo do outro", async () => {
    // seg 17:00 → ter 09:00 = 1h (seg) + 1h (ter)
    expect(await businessSeconds("2026-10-05 17:00-03", "2026-10-06 09:00-03")).toBe(2 * HOUR);
  });

  it("intervalo atravessando o fim de semana ignora sábado e domingo", async () => {
    // sex 17:30 → seg 08:30 = 30 min (sex) + 30 min (seg)
    expect(await businessSeconds("2026-10-02 17:30-03", "2026-10-05 08:30-03")).toBe(1 * HOUR);
  });

  it("feriado cadastrado não conta", async () => {
    await db.exec(`insert into painel.holidays (day, name) values ('2026-10-12', 'Nossa Senhora Aparecida')`);
    // sex 09/10 17:00 → ter 13/10 09:00 = 1h (sex) + 0 (seg feriado) + 1h (ter)
    expect(await businessSeconds("2026-10-09 17:00-03", "2026-10-13 09:00-03")).toBe(2 * HOUR);
  });

  it("feriado conta normalmente quando holidays_off está desligado", async () => {
    await db.exec(`
      insert into painel.holidays (day, name) values ('2026-10-12', 'Nossa Senhora Aparecida');
      update painel.settings set value = 'false' where key = 'holidays_off';
    `);
    expect(await businessSeconds("2026-10-09 17:00-03", "2026-10-13 09:00-03")).toBe(12 * HOUR);
  });

  it("intervalo todo fora do expediente dá zero", async () => {
    // fim de semana inteiro
    expect(await businessSeconds("2026-10-03 10:00-03", "2026-10-04 20:00-03")).toBe(0);
    // madrugada de dia útil
    expect(await businessSeconds("2026-10-05 19:00-03", "2026-10-06 07:59-03")).toBe(0);
  });

  it("intervalo vazio ou invertido dá zero", async () => {
    expect(await businessSeconds("2026-10-05 10:00-03", "2026-10-05 10:00-03")).toBe(0);
    expect(await businessSeconds("2026-10-05 11:00-03", "2026-10-05 10:00-03")).toBe(0);
  });

  it("recebe horários em UTC e converte para o fuso de negócio", async () => {
    // 12:00Z = 09:00 em São Paulo; 13:00Z = 10:00
    expect(await businessSeconds("2026-10-05 12:00Z", "2026-10-05 13:00Z")).toBe(1 * HOUR);
  });
});
