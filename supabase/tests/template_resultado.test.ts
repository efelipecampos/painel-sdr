// Resultado por template (2026-10-16): receberam, responderam de verdade, só automática, agendaram e fora das SDRs, com 24 h.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDb } from "./db";

let db: PGlite;
let n = 0;
const T0 = Date.parse("2026-10-16T13:00:00Z");
const em = (h: number) => new Date(T0 + h * 3600_000).toISOString();
let sdr: string, gestor: string;

beforeAll(async () => {
  db = await createTestDb();
  await db.exec(`select set_config('request.jwt.claims', '{"role":"service_role"}', false);`);
  sdr = (await db.query<{ id: string }>("insert into painel.sdrs (poli_email, name, role, poli_attendant_uuid) values ('ana@x', 'Ana', 'sdr', 'u-ana') returning id")).rows[0].id;
  gestor = (await db.query<{ id: string }>("insert into painel.sdrs (poli_email, name, role, poli_attendant_uuid) values ('iago@x', 'Iago', 'gestor', 'u-iago') returning id")).rows[0].id;
});
afterAll(async () => { await db.close(); });

/** Lead que recebe o template T1 do Iago em T0, no chat de `dono`, e depois as mensagens dadas (horas depois de T0). */
async function lead(dono: string, msgs: { h: number; auto?: boolean }[], reuniaoH?: number) {
  const id = (await db.query<{ id: string }>("insert into painel.leads (poli_contact_uuid) values ($1) returning id", [`c${++n}`])).rows[0].id;
  const chat = (await db.query<{ id: string }>("insert into painel.chats (poli_attendance_uuid, lead_id, sdr_id, opened_at) values ($1, $2, $3, $4) returning id", [`a${n}`, id, dono, em(0)])).rows[0].id;
  await db.query("insert into painel.chat_messages (poli_message_id, chat_id, lead_id, sdr_id, sender, template_name, author_poli_uuid, sent_at) values ($1, $2, $3, $4, 'template', 'T1', 'u-iago', $5)", [`t${n}`, chat, id, dono, em(0)]);
  for (const [i, m] of msgs.entries()) {
    await db.query("insert into painel.chat_messages (poli_message_id, chat_id, lead_id, sdr_id, sender, auto_reply, sent_at) values ($1, $2, $3, $4, 'lead', $5, $6)", [`l${n}-${i}`, chat, id, dono, !!m.auto, em(m.h)]);
  }
  if (reuniaoH !== undefined) await db.query("insert into painel.meetings (lead_id, status, source, created_at) values ($1, 'agendada', 'manual', $2)", [id, em(reuniaoH)]);
}

describe("template_resultado", () => {
  it("conta cada definição em 24 h, por quem enviou e dia", async () => {
    await lead(sdr, [{ h: 2 }], 5);                 // respondeu e agendou
    await lead(sdr, [{ h: 0.001, auto: true }]);    // só robô
    await lead(sdr, [{ h: 0.001, auto: true }, { h: 3 }]); // robô e depois resposta de verdade
    await lead(sdr, [{ h: 30 }], 40);               // respondeu e agendou depois de 24 h: não conta
    await lead(gestor, [{ h: 1 }]);                 // respondeu em chat de gestor: fora das SDRs
    await lead(sdr, []);                            // não respondeu
    const r = (await db.query("select * from painel.template_resultado('T1', $1, $2)", [em(-1), em(1)])).rows;
    expect(r).toEqual([{ dia: new Date("2026-10-16T00:00:00Z"), quem: "Iago", receberam: 6, responderam: 3, so_automatica: 1, agendaram: 1, fora_das_sdrs: 1 }]);
  });

  it("SDR não vê", async () => {
    const u = "00000000-0000-0000-0000-0000000000e1";
    await db.exec(`insert into auth.users (id) values ('${u}'); insert into painel.profiles (id, name, role, sdr_id) values ('${u}', 'Ana', 'sdr', '${sdr}');
                   select set_config('request.jwt.claims', '{"role":"authenticated"}', false); select set_config('request.jwt.claim.sub', '${u}', false); set role authenticated;`);
    await expect(db.query("select * from painel.template_resultado('T1', now() - interval '1 day', now())")).rejects.toThrow(/permissão/);
    await db.exec(`reset role; select set_config('request.jwt.claims', '{"role":"service_role"}', false);`);
  });
});
