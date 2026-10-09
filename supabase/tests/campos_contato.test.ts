// Campos do Contato no HubSpot calculados pelo painel (2026-10-09).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDb } from "./db";

let db: PGlite;
let seq = 0;
const ms = (iso: string) => String(Date.parse(iso));

beforeAll(async () => {
  db = await createTestDb();
  await db.exec(`select set_config('request.jwt.claims', '{"role":"service_role"}', false);`);
});
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec(`delete from painel.hubspot_contato_campos; delete from painel.chat_messages; delete from painel.chats;
                 delete from painel.leads; delete from painel.hubspot_leads; delete from public.messages;`);
});

type Msg = [string, string, { template?: string; note?: string }?];
/** Contato do HubSpot com um lead da Poli e mensagens [tipo, data, extra]. */
async function contato(msgs: Msg[]) {
  const c = `hc${++seq}`;
  const lead = (await db.query<{ id: string }>("insert into painel.leads (poli_contact_uuid, hubspot_contact_id) values ($1, $2) returning id", [`poli-${seq}`, c])).rows[0].id;
  const chat = (await db.query<{ id: string }>("insert into painel.chats (poli_attendance_uuid, lead_id, opened_at) values ($1, $2, now()) returning id", [`a${seq}`, lead])).rows[0].id;
  for (const [i, [sender, at, x]] of msgs.entries()) {
    await db.query(`insert into painel.chat_messages (poli_message_id, chat_id, lead_id, sender, sent_at, by_human, template_name, note_tag, system_type)
                    values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [`m${seq}-${i}`, chat, lead, sender, at, sender === "sdr", x?.template ?? null, x?.note ?? null, x?.note ? "NOTE" : null]);
  }
  return { c, poli: `poli-${seq}` };
}
const campos = async (c: string) => (await db.query<{ v: Record<string, string> | null }>("select painel.campos_contato($1) as v", [c])).rows[0].v;

describe("campos_contato", () => {
  it("última mensagem, direção, aguardando e link (regra da integração para aguardando)", async () => {
    const { c, poli } = await contato([["template", "2026-10-05T12:00:00Z", { template: "abertura" }], ["lead", "2026-10-05T13:30:00Z"], ["bot", "2026-10-05T13:31:00Z"]]);
    expect(await campos(c)).toMatchObject({
      poli_ultima_mensagem_em: ms("2026-10-05T13:31:00Z"), poli_direcao_ultima_mensagem: "ENVIADA", poli_aguardando_resposta: "false",
      id_do_contato_na_poli: poli, link_do_chat_na_poli: `https://app.poli.digital/chat/${poli}`,
    });
  });

  it("ciclo: primeiro template, primeira resposta depois dele, horas corridas com 1 casa; follow-up não recomeça", async () => {
    const { c } = await contato([
      ["template", "2026-10-02T12:00:00Z", { template: "abertura" }],
      ["template", "2026-10-03T12:00:00Z", { template: "follow-up n8n" }],
      ["lead", "2026-10-03T13:15:00Z"],
    ]);
    expect(await campos(c)).toMatchObject({
      poli_prospeccao_iniciada_em: ms("2026-10-02T12:00:00Z"), poli_template_da_prospeccao: "abertura",
      poli_primeira_resposta_em: ms("2026-10-03T13:15:00Z"), poli_tempo_ate_resposta_horas: "25.3",
      poli_direcao_ultima_mensagem: "RECEBIDA", poli_aguardando_resposta: "true",
    });
  });

  it("ciclo aberto sem resposta: resposta e horas vazias", async () => {
    const { c } = await contato([["template", "2026-10-02T12:00:00Z", { template: "abertura" }]]);
    expect(await campos(c)).toMatchObject({ poli_primeira_resposta_em: "", poli_tempo_ate_resposta_horas: "" });
  });

  it("nota de descarte recomeça o ciclo: o próximo template abre o ciclo novo", async () => {
    const { c } = await contato([
      ["template", "2026-10-02T12:00:00Z", { template: "abertura" }], ["lead", "2026-10-02T13:00:00Z"],
      ["system", "2026-10-03T12:00:00Z", { note: "descartado" }],
      ["template", "2026-10-06T12:00:00Z", { template: "reativação" }],
    ]);
    expect(await campos(c)).toMatchObject({ poli_prospeccao_iniciada_em: ms("2026-10-06T12:00:00Z"), poli_template_da_prospeccao: "reativação", poli_primeira_resposta_em: "" });
  });

  it("entrada em Descartado no HubSpot recomeça o ciclo; sem template novo, não mexe no ciclo", async () => {
    const { c } = await contato([["template", "2026-10-02T12:00:00Z", { template: "abertura" }], ["lead", "2026-10-02T13:00:00Z"]]);
    await db.query("insert into painel.hubspot_leads (hubspot_lead_id, hubspot_contact_id, entered_descartado_at) values ('h1', $1, '2026-10-04T12:00:00Z')", [c]);
    const v = await campos(c);
    expect(v).not.toHaveProperty("poli_prospeccao_iniciada_em");
    expect(v).toHaveProperty("poli_ultima_mensagem_em");
  });

  it("inbound (lead escreveu primeiro, sem template): não mexe no ciclo", async () => {
    const { c } = await contato([["lead", "2026-10-02T12:00:00Z"], ["sdr", "2026-10-02T12:05:00Z"]]);
    expect(await campos(c)).not.toHaveProperty("poli_prospeccao_iniciada_em");
  });

  it("contato com mensagem antes de 01/10 (painel não viu o ciclo inteiro): não mexe no ciclo, a não ser que recomece depois", async () => {
    const { c } = await contato([["template", "2026-10-03T12:00:00Z", { template: "follow-up" }]]);
    await db.query("insert into public.messages (direction, sent_at, hubspot_contact_id) values ('OUT', '2026-09-20T12:00:00Z', $1)", [c]);
    expect(await campos(c)).not.toHaveProperty("poli_prospeccao_iniciada_em");
    const { c: c2 } = await contato([["system", "2026-10-02T12:00:00Z", { note: "dsq" }], ["template", "2026-10-03T12:00:00Z", { template: "nova" }]]);
    await db.query("insert into public.messages (direction, sent_at, hubspot_contact_id) values ('OUT', '2026-09-20T12:00:00Z', $1)", [c2]);
    expect(await campos(c2)).toMatchObject({ poli_template_da_prospeccao: "nova" });
  });
});

describe("fila de contatos sujos", () => {
  it("mensagem nova, contato ligado depois e entrada em Descartado deixam o contato sujo", async () => {
    const { c } = await contato([["lead", "2026-10-05T12:00:00Z"]]);
    expect((await db.query("select 1 from painel.hubspot_contato_campos where hubspot_contact_id = $1 and sujo", [c])).rows).toHaveLength(1);
    await db.query("update painel.hubspot_contato_campos set sujo = false");
    await db.query("insert into painel.hubspot_leads (hubspot_lead_id, hubspot_contact_id, entered_descartado_at) values ('h9', $1, now())", [c]);
    expect((await db.query("select 1 from painel.hubspot_contato_campos where sujo")).rows).toHaveLength(1);
    await db.query("update painel.hubspot_contato_campos set sujo = false");
    const lead = (await db.query<{ id: string }>("insert into painel.leads (poli_contact_uuid) values ('solto') returning id")).rows[0].id;
    await db.query("update painel.leads set hubspot_contact_id = 'hc-novo' where id = $1", [lead]);
    expect((await db.query<{ id: string }>("select hubspot_contact_id as id from painel.hubspot_contato_campos where sujo")).rows).toEqual([{ id: "hc-novo" }]);
  });

  it("navegador não lê a fila nem os valores", async () => {
    await db.exec(`select set_config('request.jwt.claims', '{"role":"authenticated"}', false); set role authenticated;`);
    try {
      await expect(db.query("select * from painel.contatos_hubspot_pendentes(10)")).rejects.toThrow(/permission denied/);
      await expect(db.query("select * from painel.hubspot_contato_campos")).rejects.toThrow(/permission denied/);
    } finally {
      await db.exec(`reset role; select set_config('request.jwt.claims', '{"role":"service_role"}', false);`);
    }
  });
});
