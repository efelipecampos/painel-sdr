// Fase 11: tabelas da jornada configurável (acesso só de gestor e admin; mesmo clique e mesmo lead não enviam duas vezes).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDb } from "./db";

let db: PGlite;
const SDR_USER = "00000000-0000-0000-0000-0000000000a1";
const GESTOR_USER = "00000000-0000-0000-0000-0000000000a2";
let evento = 0;

beforeAll(async () => {
  db = await createTestDb();
  await db.exec(`insert into auth.users (id) values ('${SDR_USER}'), ('${GESTOR_USER}');`);
  const sdr = (await db.query<{ id: string }>("insert into painel.sdrs (poli_email, name, role) values ('sdr@x', 'SDR', 'sdr') returning id")).rows[0].id;
  await db.query("insert into painel.profiles (id, name, role, sdr_id) values ($1, 'SDR', 'sdr', $2), ($3, 'Gestor', 'gestor', null)", [SDR_USER, sdr, GESTOR_USER]);
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await db.exec(`
    reset role;
    select set_config('request.jwt.claims', '{"role":"service_role"}', false);
    select set_config('request.jwt.claim.sub', '', false);
    delete from painel.journey_sends; delete from painel.journey_rule_changes; delete from painel.journey_rules;
  `);
});

async function como(user: string) {
  await db.exec(`select set_config('request.jwt.claims', '{"role":"authenticated"}', false);
                 select set_config('request.jwt.claim.sub', '${user}', false); set role authenticated;`);
}
async function regra(): Promise<string> {
  return (await db.query<{ id: string }>(
    "insert into painel.journey_rules (origin_template_uuid, origin_button, janela, dest_template_uuid) values ('t-ab', 'Eu e mais 1', 'sempre', 't-fim') returning id",
  )).rows[0].id;
}
async function clique(): Promise<number> {
  return (await db.query<{ id: number }>(
    "insert into public.raw_events (event_type, external_id, payload) values ('messages.message.received', $1, '{}') returning id", [`ev${++evento}`],
  )).rows[0].id;
}
async function envio(rule: string, ev: number, contato: string, status = "enviado", mode = "real", dest = "t-fim") {
  await db.query(
    "insert into painel.journey_sends (rule_id, click_event_id, poli_contact_uuid, clicked_at, mode, status, dest_template_uuid) values ($1, $2, $3, now(), $4, $5::painel.journey_send_status, $6)",
    [rule, ev, contato, mode, status, dest],
  );
}

describe("regras e configurações", () => {
  it("regra nasce em teste, sem limite diário, e as chaves da jornada existem", async () => {
    const id = await regra();
    const r = (await db.query<{ status: string; daily_limit: number | null }>("select status, daily_limit from painel.journey_rules where id = $1", [id])).rows[0];
    expect(r).toEqual({ status: "teste", daily_limit: null });
    const cfg = (await db.query("select paused, test_phone from painel.journey_config")).rows;
    expect(cfg).toEqual([{ paused: false, test_phone: null }]);
    expect((await db.query("select 1 from painel.settings where key = 'journey_cursor'")).rows).toHaveLength(1);
  });

  it("não deixa duas regras para o mesmo template, botão e horário", async () => {
    await regra();
    await expect(regra()).rejects.toThrow();
  });
});

describe("envios", () => {
  it("o mesmo clique não é processado duas vezes pela mesma regra", async () => {
    const id = await regra(); const ev = await clique();
    await envio(id, ev, "c1", "pulado");
    await expect(envio(id, ev, "c1", "pulado")).rejects.toThrow();
  });

  it("a mesma regra não envia de verdade duas vezes ao mesmo lead, mas registra teste e falhas", async () => {
    const id = await regra();
    await envio(id, await clique(), "c1", "enviado", "real");
    await expect(envio(id, await clique(), "c1", "enviado", "real")).rejects.toThrow();
    await envio(id, await clique(), "c1", "enviado", "teste");
    await envio(id, await clique(), "c1", "falhou", "real");
    const n = (await db.query<{ n: number }>("select count(*)::int as n from painel.journey_sends where rule_id = $1", [id])).rows[0].n;
    expect(n).toBe(3);
  });
});

describe("trava por template (16/10)", () => {
  it("regra editada para outro template pode enviar de novo ao mesmo lead", async () => {
    const id = await regra();
    await envio(id, await clique(), "c1", "enviado", "real", "t-antigo");
    await envio(id, await clique(), "c1", "enviado", "real", "t-novo");
    await expect(envio(id, await clique(), "c1", "enviado", "real", "t-novo")).rejects.toThrow();
  });
});

describe("acesso", () => {
  it("gestor lê e cria regras; SDR não vê nada da jornada", async () => {
    await regra();
    await como(GESTOR_USER);
    expect((await db.query("select * from painel.journey_rules")).rows).toHaveLength(1);
    await db.query("insert into painel.journey_rules (origin_template_uuid, origin_button, janela, dest_template_uuid) values ('t-ab', '3 ou mais', 'fora', 't-manha')");
    await como(SDR_USER);
    expect((await db.query("select * from painel.journey_rules")).rows).toHaveLength(0);
    expect((await db.query("select * from painel.journey_sends")).rows).toHaveLength(0);
    expect((await db.query("select * from painel.poli_templates")).rows).toHaveLength(0);
    await expect(db.query("insert into painel.journey_rules (origin_template_uuid, origin_button, janela, dest_template_uuid) values ('x', 'y', 'sempre', 'z')")).rejects.toThrow();
  });

  it("gestor pausa a jornada e cadastra o telefone de teste; SDR não", async () => {
    await como(GESTOR_USER);
    await db.query("update painel.journey_config set paused = true, test_phone = '5500000000000'");
    expect((await db.query("select paused from painel.journey_config")).rows).toEqual([{ paused: true }]);
    await como(SDR_USER);
    expect((await db.query("select * from painel.journey_config")).rows).toHaveLength(0);
    await db.query("update painel.journey_config set paused = false");
    await db.exec("reset role; select set_config('request.jwt.claims', '{\"role\":\"service_role\"}', false);");
    expect((await db.query("select paused from painel.journey_config")).rows).toEqual([{ paused: true }]);
    await db.query("update painel.journey_config set paused = false, test_phone = null");
  });

  it("gestor não grava envios (só o worker)", async () => {
    const id = await regra(); const ev = await clique();
    await como(GESTOR_USER);
    await expect(envio(id, ev, "c1")).rejects.toThrow();
  });
});

describe("mensagem de texto (16/10)", () => {
  it("regra de texto precisa de texto e não precisa de template; regra de template precisa do template", async () => {
    await db.query("insert into painel.journey_rules (origin_template_uuid, origin_button, janela, tipo, texto) values ('t-ab', 'Eu e mais 1', 'fora', 'texto', 'Oi [contact_first_name]!')");
    await expect(db.query("insert into painel.journey_rules (origin_template_uuid, origin_button, janela, tipo, texto) values ('t-ab', '3 ou mais', 'fora', 'texto', '  ')")).rejects.toThrow();
    await expect(db.query("insert into painel.journey_rules (origin_template_uuid, origin_button, janela, tipo) values ('t-ab', '3 ou mais', 'expediente', 'template')")).rejects.toThrow();
  });
});
