// Finalizar lead à mão (2026-10-08): mesmo efeito da nota "0"; SDR, gestor e admin podem; dá para desfazer.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDb } from "./db";

let db: PGlite;
const uid = {
  sdrA: "00000000-0000-0000-0000-00000000001a",
  sdrB: "00000000-0000-0000-0000-00000000001b",
  inativo: "00000000-0000-0000-0000-00000000001c",
};
let sdrA = "";
let lead = "";
const FROM = "2026-10-01T03:00:00Z";
const TO = "2030-01-01T03:00:00Z";

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

const situacao = async (user: string) =>
  (await as<{ situacao: string; fora_motivo: string | null }>(user, "select situacao, fora_motivo from painel.sdr_chats($1, $2, $3, false)", [sdrA, FROM, TO]))[0];

beforeAll(async () => {
  db = await createTestDb();
  await db.exec(`select set_config('request.jwt.claims', '{"role":"service_role"}', false);`);
  sdrA = (await db.query<{ id: string }>("insert into painel.sdrs (poli_email, name, role) values ('a@x', 'SDR A', 'sdr') returning id")).rows[0].id;
  const sdrB = (await db.query<{ id: string }>("insert into painel.sdrs (poli_email, name, role) values ('b@x', 'SDR B', 'sdr') returning id")).rows[0].id;
  const sdrC = (await db.query<{ id: string }>("insert into painel.sdrs (poli_email, name, role, active) values ('c@x', 'SDR C', 'sdr', false) returning id")).rows[0].id;
  lead = (await db.query<{ id: string }>("insert into painel.leads (poli_contact_uuid, name) values ('c1', 'Lead parado') returning id")).rows[0].id;
  const chat = (await db.query<{ id: string }>(
    "insert into painel.chats (poli_attendance_uuid, lead_id, sdr_id, opened_at) values ('a1', $1, $2, now()) returning id", [lead, sdrA],
  )).rows[0].id;
  // o lead escreveu e ninguém respondeu: "Aguardando"
  await db.query(
    "insert into painel.chat_messages (poli_message_id, chat_id, lead_id, sdr_id, sender, sent_at, by_human) values ('m1', $1, $2, $3, 'lead', now() - interval '3 days', false)",
    [chat, lead, sdrA],
  );
  await db.query("select painel.rebuild_leads($1::uuid[])", [[lead]]);
  await db.exec(`insert into auth.users (id) values ${Object.values(uid).map((u) => `('${u}')`).join(",")};`);
  await db.query(
    `insert into painel.profiles (id, name, role, sdr_id, active) values
       ($1, 'SDR A', 'sdr', $4, true), ($2, 'SDR B', 'sdr', $5, true), ($3, 'Inativo', 'sdr', $6, false)`,
    [uid.sdrA, uid.sdrB, uid.inativo, sdrA, sdrB, sdrC],
  );
});

afterAll(async () => {
  await db?.close();
});

describe("finalizar lead à mão", () => {
  it("o lead parado começa em Aguardando", async () => {
    expect(await situacao(uid.sdrA)).toEqual({ situacao: "aguardando", fora_motivo: null });
  });

  it("outro SDR finaliza: sai de Aguardando, com o motivo 'Finalizado (painel)'; repetir não duplica", async () => {
    await as(uid.sdrB, "select painel.finalizar_lead($1, true)", [lead]);
    await as(uid.sdrB, "select painel.finalizar_lead($1, true)", [lead]);
    expect(await situacao(uid.sdrA)).toEqual({ situacao: "fora_do_funil", fora_motivo: "Finalizado (painel)" });
    const rows = (await db.query<{ by: string }>("select finalized_by as by from painel.lead_finalizacoes where lead_id = $1", [lead])).rows;
    expect(rows).toEqual([{ by: uid.sdrB }]);
  });

  it("desfazer devolve para Aguardando e guarda quem desfez", async () => {
    await as(uid.sdrA, "select painel.finalizar_lead($1, false)", [lead]);
    expect(await situacao(uid.sdrA)).toEqual({ situacao: "aguardando", fora_motivo: null });
    const r = (await db.query<{ by: string }>("select undone_by as by from painel.lead_finalizacoes where lead_id = $1", [lead])).rows;
    expect(r).toEqual([{ by: uid.sdrA }]);
  });

  it("usuário inativo não finaliza; ninguém lê a tabela direto", async () => {
    await expect(as(uid.inativo, "select painel.finalizar_lead($1, true)", [lead])).rejects.toThrow(/acesso negado/);
    await expect(as(uid.sdrA, "select * from painel.lead_finalizacoes")).rejects.toThrow(/permission denied/);
  });
});
