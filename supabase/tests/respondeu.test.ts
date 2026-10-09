// "Respondeu template" (2026-10-09): quais Leads do HubSpot o worker marca quando o lead escreve.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDb } from "./db";

let db: PGlite;
let seq = 0;

beforeAll(async () => {
  db = await createTestDb();
  await db.exec(`select set_config('request.jwt.claims', '{"role":"service_role"}', false);`);
});
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec("delete from painel.chat_messages; delete from painel.chats; delete from painel.leads; delete from painel.hubspot_leads;");
});

/** Contato com mensagens (tipo, data) e Leads do HubSpot (id, criação, já marcado no HubSpot). */
async function contato(msgs: [string, string][], hls: [string, string, boolean?][]) {
  const c = `hc${++seq}`;
  const lead = (await db.query<{ id: string }>("insert into painel.leads (poli_contact_uuid, hubspot_contact_id) values ($1, $2) returning id", [`p${seq}`, c])).rows[0].id;
  const chat = (await db.query<{ id: string }>("insert into painel.chats (poli_attendance_uuid, lead_id, opened_at) values ($1, $2, now()) returning id", [`a${seq}`, lead])).rows[0].id;
  for (const [i, [sender, at]] of msgs.entries()) {
    await db.query("insert into painel.chat_messages (poli_message_id, chat_id, lead_id, sender, sent_at, by_human) values ($1, $2, $3, $4, $5, $6)",
      [`m${seq}-${i}`, chat, lead, sender, at, sender === "sdr"]);
  }
  for (const [id, criado, marcado] of hls) {
    await db.query("insert into painel.hubspot_leads (hubspot_lead_id, hubspot_contact_id, created_at, respondeu_template) values ($1, $2, $3, $4)",
      [id, c, criado, marcado ?? null]);
  }
}
const pendentes = async () =>
  (await db.query<{ hubspot_lead_id: string }>("select hubspot_lead_id from painel.leads_para_marcar_resposta(100) order by 1")).rows.map((r) => r.hubspot_lead_id);

describe("leads_para_marcar_resposta", () => {
  it("lead que respondeu ao template é marcado; quem só recebeu template não", async () => {
    await contato([["template", "2026-10-05T12:00:00Z"], ["lead", "2026-10-05T12:30:00Z"]], [["L1", "2026-10-05T11:00:00Z"]]);
    await contato([["template", "2026-10-05T12:00:00Z"], ["bot", "2026-10-06T12:00:00Z"]], [["L2", "2026-10-05T11:00:00Z"]]);
    expect(await pendentes()).toEqual(["L1"]);
  });

  it("já marcado no HubSpot ou já marcado pelo painel: não marca de novo", async () => {
    await contato([["lead", "2026-10-05T12:30:00Z"]], [["L1", "2026-10-05T11:00:00Z", true]]);
    await contato([["lead", "2026-10-05T12:30:00Z"]], [["L2", "2026-10-05T11:00:00Z"]]);
    await db.query("update painel.hubspot_leads set respondeu_marcado_at = now() where hubspot_lead_id = 'L2'");
    expect(await pendentes()).toEqual([]);
  });

  it("resposta de um ciclo antigo não marca o Lead novo; resposta no ciclo novo marca", async () => {
    await contato([["lead", "2026-10-02T12:00:00Z"]], [["VELHO", "2026-10-01T12:00:00Z", true], ["NOVO", "2026-10-06T12:00:00Z"]]);
    expect(await pendentes()).toEqual([]);
    await contato([["lead", "2026-10-02T12:00:00Z"], ["lead", "2026-10-07T12:00:00Z"]], [["VELHO2", "2026-10-01T12:00:00Z", true], ["NOVO2", "2026-10-06T12:00:00Z"]]);
    expect(await pendentes()).toEqual(["NOVO2"]);
  });

  it("lead que escreveu pouco antes de o Lead ser criado (inbound) também é marcado", async () => {
    await contato([["lead", "2026-10-05T11:50:00Z"]], [["L1", "2026-10-05T12:00:00Z"]]);
    expect(await pendentes()).toEqual(["L1"]);
  });

  it("navegador não chama a função", async () => {
    await db.exec(`select set_config('request.jwt.claims', '{"role":"authenticated"}', false); set role authenticated;`);
    try {
      await expect(db.query("select * from painel.leads_para_marcar_resposta(10)")).rejects.toThrow(/permission denied/);
    } finally {
      await db.exec(`reset role; select set_config('request.jwt.claims', '{"role":"service_role"}', false);`);
    }
  });
});
