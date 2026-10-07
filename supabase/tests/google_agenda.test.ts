// Fase 10c: papel closer e conexão da agenda. O closer só vê a situação da própria agenda; ninguém logado
// lê as conexões (token cifrado) nem o registro de falhas; o closer não entra nas telas de SDR e gestor.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDb } from "./db";

let db: PGlite;
const uid = { ana: "00000000-0000-0000-0000-0000000003a1", bia: "00000000-0000-0000-0000-0000000003a2", admin: "00000000-0000-0000-0000-0000000003a3" };
const closer: Record<string, string> = {};
const FROM = "2026-10-05T03:00:00Z";
const TO = "2026-10-06T03:00:00Z";

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
  for (const k of ["ana", "bia"]) {
    closer[k] = (await db.query<{ id: string }>("insert into painel.sdrs (poli_email, name, role) values ($1, $2, 'closer') returning id", [`${k}@poli.digital`, k])).rows[0].id;
  }
  await db.query("insert into auth.users (id, email) values ($1, 'ana@poli.digital'), ($2, 'bia@poli.digital'), ($3, 'adm@poli.digital')", [uid.ana, uid.bia, uid.admin]);
  await db.query("insert into painel.profiles (id, name, role, sdr_id) values ($1, 'Ana', 'closer', $3), ($2, 'Bia', 'closer', $4), ($5, 'Adm', 'admin', null)",
    [uid.ana, uid.bia, closer.ana, closer.bia, uid.admin]);
  await db.query("insert into painel.google_connections (closer_id, google_email, refresh_token_enc, scopes) values ($1, 'ana@poli.digital', 'v1:xyz', '{a}')", [closer.ana]);
});

afterAll(async () => {
  await db.close();
});

describe("closer", () => {
  it("vê só a situação da própria agenda, sem o token", async () => {
    const ana = await as(uid.ana, "select * from painel.minha_agenda_google()");
    expect(ana).toHaveLength(1);
    expect(Object.keys(ana[0]).sort()).toEqual(["connected_at", "google_email", "last_error", "status"]);
    expect(await as(uid.bia, "select * from painel.minha_agenda_google()")).toEqual([]);
    await expect(as(uid.admin, "select * from painel.minha_agenda_google()")).rejects.toThrow(/acesso negado/);
  });

  it("não lê conexões nem o registro de falhas direto", async () => {
    await expect(as(uid.ana, "select * from painel.google_connections")).rejects.toThrow(/permission denied/);
    await expect(as(uid.ana, "select * from painel.calendar_log")).rejects.toThrow(/permission denied/);
    await expect(as(uid.admin, "select * from painel.google_connections")).rejects.toThrow(/permission denied/);
  });

  it("não entra nas telas de SDR, de gestor nem no agendamento", async () => {
    for (const sql of [
      "select * from painel.sdr_metrics($1, $2)", "select * from painel.team_metrics($1, $2)",
    ]) await expect(as(uid.ana, sql, [FROM, TO])).rejects.toThrow(/acesso negado/);
    await expect(as(uid.ana, "select * from painel.sdr_chats($1, $2, $3)", [closer.ana, FROM, TO])).rejects.toThrow(/acesso negado/);
    await expect(as(uid.ana, "select * from painel.carrosseis_para_agendar()")).rejects.toThrow(/acesso negado/);
    await expect(as(uid.ana, "select * from painel.usuarios()")).rejects.toThrow(/acesso negado/);
    expect(await as(uid.ana, "select * from painel.carousels")).toEqual([]);
  });

  it("perfil de closer exige o atendente ligado", async () => {
    await expect(db.query("insert into painel.profiles (id, name, role) values ($1, 'x', 'closer')", [uid.bia])).rejects.toThrow(/profiles_sdr_id_chk|duplicate/);
    await db.query("insert into auth.users (id) values ('00000000-0000-0000-0000-0000000003a9')");
    await expect(db.query("insert into painel.profiles (id, name, role) values ('00000000-0000-0000-0000-0000000003a9', 'x', 'closer')")).rejects.toThrow(/profiles_sdr_id_chk/);
  });
});

describe("tela Usuários", () => {
  it("mostra a situação da agenda dos closers", async () => {
    const rows = await as<{ name: string; agenda: string | null }>(uid.admin, "select name, agenda from painel.usuarios()");
    const by = Object.fromEntries(rows.map((r) => [r.name, r.agenda]));
    expect(by).toMatchObject({ Ana: "conectada", Bia: "nao_conectada", Adm: null });
  });
});
