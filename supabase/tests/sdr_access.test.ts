// Fase 10a: um SDR logado só vê os próprios dados; não altera perfis; não acessa tabelas direto.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDb } from "./db";

let db: PGlite;
const uid = {
  sdrA: "00000000-0000-0000-0000-00000000000a",
  sdrB: "00000000-0000-0000-0000-00000000000b",
  gestor: "00000000-0000-0000-0000-00000000000c",
  admin: "00000000-0000-0000-0000-00000000000d",
  inativo: "00000000-0000-0000-0000-00000000000e",
  semPerfil: "00000000-0000-0000-0000-00000000000f",
};
const sdr: Record<string, string> = {};
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
  for (const k of ["A", "B"]) {
    sdr[k] = (await db.query<{ id: string }>(
      "insert into painel.sdrs (poli_email, name, role) values ($1, $2, 'sdr') returning id", [`${k}@x`, `SDR ${k}`],
    )).rows[0].id;
    const lead = (await db.query<{ id: string }>(
      "insert into painel.leads (poli_contact_uuid, name, phone_e164) values ($1, $2, '+5562912340000') returning id", [`c${k}`, `Lead do ${k}`],
    )).rows[0].id;
    const chat = (await db.query<{ id: string }>(
      "insert into painel.chats (poli_attendance_uuid, lead_id, sdr_id, opened_at) values ($1, $2, $3, now()) returning id", [`a${k}`, lead, sdr[k]],
    )).rows[0].id;
    await db.query(
      `insert into painel.chat_messages (poli_message_id, chat_id, lead_id, sdr_id, sender, sent_at, by_human) values
         ($1, $2, $3, $4, 'lead', '2026-10-05T12:00:00Z', false), ($5, $2, $3, $4, 'sdr', '2026-10-05T12:05:00Z', true)`,
      [`m1${k}`, chat, lead, sdr[k], `m2${k}`],
    );
    await db.query("select painel.rebuild_leads($1::uuid[])", [[lead]]);
    await db.query("insert into painel.meetings (lead_id, sdr_id, status, source) values ($1, $2, 'agendada', 'manual')", [lead, sdr[k]]);
  }
  // SDR desativado na lista de atendentes (não entra nos cards), para o perfil inativo
  sdr.C = (await db.query<{ id: string }>("insert into painel.sdrs (poli_email, name, role, active) values ('C@x', 'SDR C', 'sdr', false) returning id")).rows[0].id;
  await db.exec(`insert into auth.users (id) values ${Object.values(uid).map((u) => `('${u}')`).join(",")};`);
  await db.query(
    `insert into painel.profiles (id, name, role, sdr_id, active) values
       ($1, 'SDR A', 'sdr', $5, true), ($2, 'SDR B', 'sdr', $6, true), ($3, 'Gestor', 'gestor', null, true),
       ($4, 'Admin', 'admin', null, true), ($7, 'Inativo', 'sdr', $8, false)`,
    [uid.sdrA, uid.sdrB, uid.gestor, uid.admin, sdr.A, sdr.B, uid.inativo, sdr.C],
  );
});

afterAll(async () => {
  await db.close();
});

describe("SDR logado vê só o que é dele", () => {
  it("sdr_metrics devolve só a linha do próprio SDR", async () => {
    const rows = await as<{ sdr_id: string; name: string }>(uid.sdrA, "select sdr_id, name from painel.sdr_metrics($1, $2)", [FROM, TO]);
    expect(rows).toEqual([{ sdr_id: sdr.A, name: "SDR A" }]);
  });

  it("sdr_chats do próprio SDR funciona e não traz lead de outro", async () => {
    const rows = await as<{ lead_name: string }>(uid.sdrA, "select lead_name from painel.sdr_chats($1, $2, $3, false)", [sdr.A, FROM, TO]);
    expect(rows.map((r) => r.lead_name)).toEqual(["Lead do A"]);
  });

  it("sdr_chats de outro SDR: acesso negado", async () => {
    await expect(as(uid.sdrA, "select * from painel.sdr_chats($1, $2, $3)", [sdr.B, FROM, TO])).rejects.toThrow(/acesso negado/);
  });

  it("team_metrics (visão do time): acesso negado", async () => {
    await expect(as(uid.sdrA, "select * from painel.team_metrics($1, $2)", [FROM, TO])).rejects.toThrow(/acesso negado/);
  });

  it("set_meeting_status: acesso negado, inclusive no próprio lead", async () => {
    const leadA = (await db.query<{ id: string }>("select id from painel.leads where poli_contact_uuid = 'cA'")).rows[0].id;
    await expect(as(uid.sdrA, "select painel.set_meeting_status($1, 'validada')", [leadA])).rejects.toThrow(/acesso negado/);
  });

  it.each(["chats", "leads", "chat_messages", "meetings", "meeting_status_history", "response_events", "sdrs", "hubspot_leads", "chat_owner_history"])(
    "ler painel.%s direto: permissão negada",
    async (table) => {
      await expect(as(uid.sdrA, `select * from painel.${table} limit 1`)).rejects.toThrow(/permission denied/);
    },
  );

  it("tabelas da integração: permissão negada", async () => {
    await expect(as(uid.sdrA, "select * from public.raw_events limit 1")).rejects.toThrow(/permission denied/);
    await expect(as(uid.sdrA, "select * from public.messages limit 1")).rejects.toThrow(/permission denied/);
  });

  it("profiles: lê só o próprio perfil", async () => {
    const rows = await as<{ id: string }>(uid.sdrA, "select id from painel.profiles");
    expect(rows.map((r) => r.id)).toEqual([uid.sdrA]);
  });
});

describe("SDR não altera perfis nem configurações", () => {
  it("não altera o próprio papel, sdr_id nem ativo", async () => {
    for (const set of ["role = 'admin'", `sdr_id = '${sdr.B}'`, "active = false", "name = 'x'"]) {
      await expect(as(uid.sdrA, `update painel.profiles set ${set} where id = '${uid.sdrA}'`)).rejects.toThrow(/permission denied/);
    }
    const me = (await db.query<{ role: string; sdr_id: string; active: boolean }>(
      "select role, sdr_id, active from painel.profiles where id = $1", [uid.sdrA],
    )).rows[0];
    expect(me).toEqual({ role: "sdr", sdr_id: sdr.A, active: true });
  });

  it("não cria outro perfil nem apaga perfis", async () => {
    await expect(as(uid.sdrA, `insert into painel.profiles (id, name, role) values ('${uid.semPerfil}', 'x', 'admin')`)).rejects.toThrow(/permission denied/);
    await expect(as(uid.sdrA, `delete from painel.profiles where id = '${uid.gestor}'`)).rejects.toThrow(/permission denied/);
  });

  it("não grava configurações (RLS de admin)", async () => {
    await as(uid.sdrA, "update painel.settings set value = '99' where key = 'stale_minutes'");
    await as(uid.sdrA, "delete from painel.holidays");
    expect((await db.query<{ v: number }>("select value as v from painel.settings where key = 'stale_minutes'")).rows[0].v).toBe(30);
    expect((await db.query<{ n: number }>("select count(*)::int as n from painel.holidays")).rows[0].n).toBeGreaterThan(0);
  });
});

describe("quem não é SDR ativo", () => {
  it("SDR inativo e usuário sem perfil: acesso negado em tudo", async () => {
    for (const u of [uid.inativo, uid.semPerfil]) {
      await expect(as(u, "select * from painel.sdr_metrics($1, $2)", [FROM, TO])).rejects.toThrow(/acesso negado/);
      await expect(as(u, "select * from painel.sdr_chats($1, $2, $3)", [sdr.A, FROM, TO])).rejects.toThrow(/acesso negado/);
    }
  });

  it("o banco não aceita perfil SDR sem sdr_id, nem gestor com sdr_id", async () => {
    await expect(db.query(`insert into painel.profiles (id, name, role) values ('${uid.semPerfil}', 'x', 'sdr')`)).rejects.toThrow(/profiles_sdr_id_chk/);
    await expect(db.query(`insert into painel.profiles (id, name, role, sdr_id) values ('${uid.semPerfil}', 'x', 'gestor', '${sdr.B}')`)).rejects.toThrow(/profiles_sdr_id_chk/);
  });
});

describe("gestor e admin continuam vendo tudo (regressão)", () => {
  it.each(["gestor", "admin"] as const)("%s vê todos os SDRs, o time e a tabela de qualquer SDR", async (who) => {
    const u = uid[who];
    expect((await as(u, "select * from painel.sdr_metrics($1, $2)", [FROM, TO])).length).toBe(2);
    expect((await as(u, "select * from painel.team_metrics($1, $2)", [FROM, TO])).length).toBe(1);
    expect((await as(u, "select * from painel.sdr_chats($1, $2, $3, false)", [sdr.B, FROM, TO])).length).toBe(1);
  });

  it("gestor marca reunião à mão", async () => {
    const leadB = (await db.query<{ id: string }>("select id from painel.leads where poli_contact_uuid = 'cB'")).rows[0].id;
    await as(uid.gestor, "select painel.set_meeting_status($1, 'validada')", [leadB]);
    expect((await db.query<{ s: string }>("select status::text as s from painel.meetings where lead_id = $1", [leadB])).rows[0].s).toBe("validada");
  });
});
