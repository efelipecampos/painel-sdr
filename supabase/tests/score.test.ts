// Fase 7b: leads a avaliar, carteira e nota por lead, com o escopo de quem está logado.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDb } from "./db";

let db: PGlite;
const uid = {
  sdrA: "00000000-0000-0000-0000-00000000000a",
  gestor: "00000000-0000-0000-0000-00000000000c",
};
const sdr: Record<string, string> = {};
const lead: Record<string, string> = {};
const PIPE = "841793591";
const ABERTA = "1250901134";      // Entrada
const QUALIFICADO = "1358962969"; // fora da carteira

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

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

async function novoLead(key: string, sdrId: string, contact: string | null, msgs: [string, number][]): Promise<string> {
  const id = (await db.query<{ id: string }>(
    "insert into painel.leads (poli_contact_uuid, hubspot_contact_id) values ($1, $2) returning id", [`c-${key}`, contact],
  )).rows[0].id;
  const chat = (await db.query<{ id: string }>(
    "insert into painel.chats (poli_attendance_uuid, lead_id, sdr_id, opened_at) values ($1, $2, $3, $4) returning id",
    [`a-${key}`, id, sdrId, ago(600)],
  )).rows[0].id;
  for (const [i, [sender, min]] of msgs.entries()) {
    await db.query(
      "insert into painel.chat_messages (poli_message_id, chat_id, lead_id, sdr_id, sender, sent_at) values ($1, $2, $3, $4, $5, $6)",
      [`m-${key}-${i}`, chat, id, sdrId, sender, ago(min)],
    );
  }
  return id;
}

async function nota(leadId: string, status: string, score: number | null, version = "v1", basedOnMin = 120): Promise<void> {
  await db.query(
    `insert into painel.lead_scores (lead_id, score, status, criteria_scores, model, criteria_version, based_on_message_at)
     values ($1, $2, $3, '[]', 'teste', $4, $5)`,
    [leadId, score, status, version, ago(basedOnMin)],
  );
}

beforeAll(async () => {
  db = await createTestDb();
  await db.exec(`select set_config('request.jwt.claims', '{"role":"service_role"}', false);`);
  for (const [k, role, active] of [["A", "sdr", true], ["B", "sdr", true], ["X", "sdr", false], ["CL", "closer", true]] as const) {
    sdr[k] = (await db.query<{ id: string }>(
      "insert into painel.sdrs (poli_email, name, role, active) values ($1, $2, $3, $4) returning id", [`${k}@x`, `SDR ${k}`, role, active],
    )).rows[0].id;
    await db.query("insert into painel.hubspot_owners (owner_id, email) values ($1, $2)", [`o${k}`, `${k}@x`]);
  }
  await db.exec(`insert into auth.users (id) values ('${uid.sdrA}'), ('${uid.gestor}');`);
  await db.query(
    "insert into painel.profiles (id, name, role, sdr_id, active) values ($1, 'SDR A', 'sdr', $3, true), ($2, 'Gestor', 'gestor', null, true)",
    [uid.sdrA, uid.gestor, sdr.A],
  );

  // Candidatos
  lead.parado = await novoLead("parado", sdr.A, "h1", [["template", 300], ["lead", 200], ["sdr", 190]]);
  lead.recente = await novoLead("recente", sdr.A, "h2", [["lead", 10]]);           // conversa ativa (< 60 min)
  lead.closer = await novoLead("closer", sdr.CL, "h3", [["lead", 200]]);           // responsável é closer
  lead.semResposta = await novoLead("muda", sdr.A, "h4", [["template", 300]]);     // nunca escreveu
  lead.jaAvaliado = await novoLead("avaliado", sdr.A, "h5", [["lead", 200]]);
  await nota(lead.jaAvaliado, "avaliado", 70, "v1", 200);
  lead.escreveuDepois = await novoLead("depois", sdr.B, "h6", [["lead", 300], ["lead", 100]]);
  await nota(lead.escreveuDepois, "abaixo_do_corte", null, "v1", 300);

  // Carteira (pipeline do SDR)
  const hl = async (id: string, contact: string, stage: string, owner: string, created: string) =>
    db.query("insert into painel.hubspot_leads (hubspot_lead_id, hubspot_contact_id, pipeline_id, stage_id, owner_id, created_at) values ($1, $2, $3, $4, $5, $6)",
      [id, contact, PIPE, stage, owner, created]);
  await hl("L1", "h1", ABERTA, "oA", "2026-10-01");
  await hl("L5", "h5", ABERTA, "oA", "2026-10-01");
  await hl("L4", "h4", ABERTA, "oA", "2026-10-01");
  await hl("L7a", "h7", ABERTA, "oA", "2026-09-01");      // Lead antigo aberto...
  await hl("L7b", "h7", QUALIFICADO, "oA", "2026-10-02"); // ...mas o mais recente está qualificado: fora
  await hl("L6", "h6", ABERTA, "oB", "2026-10-01");
  await hl("L8", "h8", ABERTA, "oX", "2026-10-01");       // SDR desativado: só na soma do time
  lead.h8 = await novoLead("h8", sdr.X, "h8", [["lead", 300]]);
  await nota(lead.h8, "avaliado", 40);
  await nota(lead.parado, "avaliado", 50, "v0", 400);    // versão antiga dos critérios
  await nota(lead.parado, "avaliado", 90, "v0", 400);    // a mais recente vale
});

afterAll(async () => { await db?.close(); });

describe("score_candidatos", () => {
  it("só leads com mensagem nova desde a última avaliação desta versão, parados e com SDR responsável", async () => {
    const rows = (await db.query<{ lead_id: string }>("select lead_id from painel.score_candidatos('v1', 100, 60)")).rows.map((r) => r.lead_id);
    // h8 já foi avaliado depois da última mensagem; recente está em conversa; closer e quem nunca escreveu ficam fora
    expect(rows.sort()).toEqual([lead.parado, lead.escreveuDepois].sort());
  });
  it("versão nova dos critérios: quem já foi avaliado volta a ser candidato", async () => {
    const rows = (await db.query<{ lead_id: string }>("select lead_id from painel.score_candidatos('v2', 100, 60)")).rows.map((r) => r.lead_id);
    expect(rows).toContain(lead.jaAvaliado);
  });
  it("respeita o limite, mais recentes primeiro", async () => {
    const rows = (await db.query<{ lead_id: string }>("select lead_id from painel.score_candidatos('v1', 1, 60)")).rows;
    expect(rows).toEqual([{ lead_id: lead.escreveuDepois }]);
  });
  it("o painel (authenticated) não chama", async () => {
    await expect(as(uid.gestor, "select * from painel.score_candidatos('v1', 10, 60)")).rejects.toThrow(/permission denied/);
  });
});

describe("carteira", () => {
  it("gestor vê cada SDR ativo e a linha do time (que inclui desativados)", async () => {
    const rows = await as<{ sdr_id: string | null; carteira: number; avaliados: number; sem_avaliacao: number; qualidade: number | null }>(
      uid.gestor, "select * from painel.carteira()");
    const by = new Map(rows.map((r) => [r.sdr_id, r]));
    // A: h1 (nota 90), h5 (nota 70), h4 (nunca respondeu); h7 está qualificado
    expect(by.get(sdr.A)).toEqual({ sdr_id: sdr.A, carteira: 3, avaliados: 2, sem_avaliacao: 1, qualidade: 80 });
    // B: h6 só tem "abaixo do corte"
    expect(by.get(sdr.B)).toEqual({ sdr_id: sdr.B, carteira: 1, avaliados: 0, sem_avaliacao: 1, qualidade: null });
    expect(by.has(sdr.X)).toBe(false);
    // time: 5 leads, 3 avaliados (90, 70, 40) → 67
    expect(by.get(null)).toEqual({ sdr_id: null, carteira: 5, avaliados: 3, sem_avaliacao: 2, qualidade: 67 });
  });
  it("SDR logado só vê a própria linha, sem a do time", async () => {
    const rows = await as<{ sdr_id: string | null }>(uid.sdrA, "select * from painel.carteira()");
    expect(rows.map((r) => r.sdr_id)).toEqual([sdr.A]);
  });
});

describe("lead_notas", () => {
  it("devolve a avaliação mais recente de cada lead", async () => {
    const rows = await as<{ lead_id: string; score: number }>(uid.gestor, "select * from painel.lead_notas($1)", [[lead.parado, lead.jaAvaliado]]);
    expect(new Map(rows.map((r) => [r.lead_id, r.score]))).toEqual(new Map([[lead.parado, 90], [lead.jaAvaliado, 70]]));
  });
  it("SDR não vê nota de lead de outro SDR", async () => {
    const rows = await as<{ lead_id: string }>(uid.sdrA, "select * from painel.lead_notas($1)", [[lead.parado, lead.escreveuDepois]]);
    expect(rows.map((r) => r.lead_id)).toEqual([lead.parado]);
  });
  it("status e nota andam juntos", async () => {
    await expect(nota(lead.parado, "avaliado", null)).rejects.toThrow(/lead_scores_score_status/);
    await expect(nota(lead.parado, "abaixo_do_corte", 50)).rejects.toThrow(/lead_scores_score_status/);
  });
});
