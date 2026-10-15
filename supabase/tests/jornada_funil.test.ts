// Fase 11: funil simples da Jornada (Lead criado → Template 1 enviado → Clicou em um dos botões → Agendamento).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDb } from "./db";

let db: PGlite;
let n = 0;
const DIA = "2026-10-14";            // quarta-feira, dia útil
const NO_EXP = `${DIA}T16:00:00Z`;   // 13:00 em São Paulo
const FORA = `${DIA}T23:30:00Z`;     // 20:30 em São Paulo

beforeAll(async () => {
  db = await createTestDb();
  await db.exec(`select set_config('request.jwt.claims', '{"role":"service_role"}', false);`);
});
afterAll(async () => {
  await db.close();
});

const mais = (iso: string, min: number) => new Date(Date.parse(iso) + min * 60_000).toISOString();

/** Um contato com Lead no HubSpot e, se pedido, template, resposta e reunião. */
async function contato(o: { criado: string; dsq?: boolean; pipeline?: string; template?: boolean; resposta?: string; reuniao?: boolean; agendadoHubspot?: boolean }) {
  const id = ++n, hs = `hs${id}`;
  await db.query(
    "insert into painel.hubspot_leads (hubspot_lead_id, hubspot_contact_id, pipeline_id, stage_id, created_at, entered_dsq_at, entered_agendado_at) values ($1, $2, $3, $4, $5, $6, $7)",
    [`l${id}`, hs, o.pipeline ?? "841793591", o.dsq ? "1250901142" : "x", o.criado, o.dsq ? o.criado : null, o.agendadoHubspot ? mais(o.criado, 60) : null],
  );
  const lead = (await db.query<{ id: string }>("insert into painel.leads (poli_contact_uuid, hubspot_contact_id) values ($1, $2) returning id", [`c${id}`, hs])).rows[0].id;
  const chat = (await db.query<{ id: string }>("insert into painel.chats (poli_attendance_uuid, lead_id, opened_at) values ($1, $2, $3) returning id", [`a${id}`, lead, o.criado])).rows[0].id;
  if (o.template) {
    const ev = (await db.query<{ id: number }>(
      "insert into public.raw_events (event_type, external_id, payload) values ('messages.message.sent', $1, $2) returning id",
      [`e${id}`, JSON.stringify({ value: { template: { uuid: "t1", message: { buttons: [{ type: "reply", text: "Eu e mais 1" }, { type: "reply", text: "3 ou mais" }] } } } })],
    )).rows[0].id;
    await db.query("insert into painel.chat_messages (poli_message_id, raw_event_id, chat_id, lead_id, sender, sent_at) values ($1, $2, $3, $4, 'template', $5)", [`t${id}`, ev, chat, lead, mais(o.criado, 4)]);
  }
  if (o.resposta) {
    await db.query("insert into painel.chat_messages (poli_message_id, chat_id, lead_id, sender, body, sent_at) values ($1, $2, $3, 'lead', $4, $5)", [`r${id}`, chat, lead, o.resposta, mais(o.criado, 10)]);
  }
  if (o.reuniao) {
    await db.query("insert into painel.meetings (lead_id, status, source, hubspot_contact_id, created_at) values ($1, 'agendada', 'manual', $2, $3)", [lead, hs, mais(o.criado, 30)]);
  }
}

async function funil() {
  const r = await db.query<{ etapa: number; nome: string; expediente: number; fora: number }>(
    "select * from painel.jornada_funil($1, $2)", [`${DIA}T03:00:00Z`, "2026-10-15T03:00:00Z"],
  );
  return r.rows.map((x) => [x.nome, x.expediente, x.fora]);
}

describe("jornada_funil", () => {
  it("conta as 4 etapas, separando pela hora em que o Lead foi criado", async () => {
    await contato({ criado: NO_EXP, template: true, resposta: " eu e MAIS 1 ", reuniao: true });   // passa por tudo
    await contato({ criado: NO_EXP, template: true, resposta: "quanto custa?" });                   // respondeu texto: não é clique
    await contato({ criado: NO_EXP, template: true, agendadoHubspot: true });                       // agendou pelo HubSpot sem clicar
    await contato({ criado: NO_EXP });                                                               // sem template
    await contato({ criado: FORA, template: true, resposta: "3 ou mais" });                         // fora do expediente, clicou
    await contato({ criado: NO_EXP, dsq: true, template: true, resposta: "3 ou mais" });            // DSQ: fora do funil
    await contato({ criado: NO_EXP, pipeline: "outro", template: true });                           // outro pipeline: fora
    await contato({ criado: "2026-10-13T16:00:00Z", template: true });                              // fora do período
    expect(await funil()).toEqual([
      ["Lead criado", 4, 1],
      ["Template 1 enviado", 3, 1],
      ["Clicou em um dos botões", 1, 1],
      ["Agendamento", 2, 0],
    ]);
  });

  it("SDR não pode ver o funil", async () => {
    const sdr = "00000000-0000-0000-0000-0000000000f1";
    await db.query("insert into painel.sdrs (poli_email, name, role) values ('funil@x', 'SDR', 'sdr')");
    await db.exec(`insert into auth.users (id) values ('${sdr}');
                   insert into painel.profiles (id, name, role, sdr_id) select '${sdr}', 'SDR', 'sdr', id from painel.sdrs where poli_email = 'funil@x';
                   select set_config('request.jwt.claims', '{"role":"authenticated"}', false);
                   select set_config('request.jwt.claim.sub', '${sdr}', false); set role authenticated;`);
    await expect(funil()).rejects.toThrow(/permissão/);
    await db.exec(`reset role; select set_config('request.jwt.claims', '{"role":"service_role"}', false);`);
  });
});
