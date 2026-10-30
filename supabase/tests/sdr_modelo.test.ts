// SDR Modelo (Fase 9a): números por SDR, versões do SDR Ideal e aderência (docs/sdr-modelo.md).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDb } from "./db";

let db: PGlite;
let seq = 0;
const sdr: Record<string, string> = {};

// Segunda-feira 05/10/2026 (fuso -03).
const day = (hhmm: string, d = "05") => `2026-10-${d}T${hhmm}:00-03:00`;
const FROM = day("00:00");
const TO = day("00:00", "06");

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec(`
    reset role;
    select set_config('request.jwt.claims', '{"role":"service_role"}', false);
    select set_config('request.jwt.claim.sub', '', false);
    delete from painel.sdr_ideal_versoes; delete from painel.holidays;
    update painel.settings set value = 'true'::jsonb where key = 'metrics_business_only';
    delete from painel.meeting_status_history; delete from painel.meetings;
    delete from painel.response_events; delete from painel.chat_owner_history; delete from painel.chat_messages;
    delete from painel.chats; delete from painel.leads; delete from painel.profiles; delete from auth.users; delete from painel.sdrs;
  `);
  for (const k of ["X", "Y"]) {
    sdr[k] = (await db.query<{ id: string }>(
      "insert into painel.sdrs (poli_email, name, role) values ($1, $2, 'sdr') returning id", [`${k.toLowerCase()}@x`, `SDR ${k}`],
    )).rows[0].id;
  }
});

/** Lead com mensagens no chat do SDR `owner`: [remetente, horário]. */
async function lead(owner: string, steps: ["lead" | "sdr" | "template_bot", string][]) {
  const leadId = (await db.query<{ id: string }>(
    "insert into painel.leads (poli_contact_uuid, name) values ($1, $2) returning id", [`c${++seq}`, `Lead ${seq}`],
  )).rows[0].id;
  const chatId = (await db.query<{ id: string }>(
    "insert into painel.chats (poli_attendance_uuid, lead_id, sdr_id, opened_at) values ($1, $2, $3, now()) returning id",
    [`a${seq}`, leadId, sdr[owner]],
  )).rows[0].id;
  for (const [i, [kind, at]] of steps.entries()) {
    await db.query(
      `insert into painel.chat_messages (poli_message_id, chat_id, lead_id, sdr_id, sender, sent_at, by_human)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [`m${seq}-${i}`, chatId, leadId, sdr[owner], kind === "template_bot" ? "template" : kind, at, kind === "sdr"],
    );
  }
  await db.query("select painel.rebuild_leads($1::uuid[])", [[leadId]]);
  return leadId;
}

async function reuniao(owner: string, leadId: string, status: string, inicio: string, criada: string, excluida = false) {
  await db.query(
    `insert into painel.meetings (lead_id, sdr_id, status, source, starts_at, ends_at, created_at, excluida_at)
     values ($1, $2, $3, 'hubspot', $4, $4::timestamptz + interval '1 hour', $5, $6)`,
    [leadId, sdr[owner], status, inicio, criada, excluida ? inicio : null],
  );
}

async function numeros() {
  const r = await db.query<Record<string, unknown>>("select * from painel.sdr_modelo_numeros($1, $2)", [FROM, TO]);
  return Object.fromEntries(r.rows.map((x) => [x.name, x]));
}

describe("dias úteis", () => {
  it("conta segunda a sexta do expediente, sem feriado; o fim é aberto", async () => {
    const r = async () => (await db.query<{ n: number }>("select painel.dias_uteis($1, $2) n", [day("00:00", "05"), day("00:00", "12")])).rows[0].n;
    expect(await r()).toBe(5);
    await db.query("insert into painel.holidays (day, name) values ('2026-10-07', 'Teste')");
    expect(await r()).toBe(4);
  });
});

describe("sdr_modelo_numeros", () => {
  it("volume, taxas, descartes ÷ abordados, validadas e confirmação até 60 min antes", async () => {
    const a = await lead("X", [["template_bot", day("09:00")], ["lead", day("09:05")], ["sdr", day("09:07")], ["sdr", day("13:30")]]);
    const b = await lead("X", [["template_bot", day("09:00")], ["lead", day("09:10")], ["sdr", day("09:12")]]);
    await lead("X", [["template_bot", day("09:00")]]);
    await lead("X", [["template_bot", day("09:00")]]);
    // a: validada, marcada na véspera, alguém da equipe escreveu 30 min antes → confirmada
    await reuniao("X", a, "validada", day("14:00"), day("10:00", "04"));
    // b: no show, marcada na véspera, sem mensagem na hora antes → não confirmada
    await reuniao("X", b, "noshow", day("15:00"), day("10:00", "04"));
    // flash: marcada 20 min antes → fora da conta de confirmação, mas é reunião
    await reuniao("X", b, "invalidada", day("16:00"), day("15:40"));
    // cancelada e excluída não contam
    await reuniao("X", a, "cancelada", day("16:30"), day("10:00", "04"));
    await reuniao("X", a, "validada", day("17:00"), day("10:00", "04"), true);
    // fora do período
    await reuniao("X", a, "validada", day("10:00", "06"), day("10:00", "04"));

    const x = (await numeros())["SDR X"];
    expect(x).toMatchObject({
      dias_uteis: 1, leads_abordados: 4, leads_responderam: 2, reunioes: 3, validadas: 1,
      reunioes_confirmacao: 2, confirmadas: 1,
    });
    expect(Number(x.volume)).toBe(4);
    expect(Number(x.taxa_resposta)).toBe(50);
    expect(Number(x.taxa_validadas)).toBe(50);
    expect(Number(x.taxa_confirmacao)).toBe(50);
    expect(Number(x.taxa_descarte)).toBe(0);
  });

  it("o SDR recebe só a própria linha; gestor recebe todos", async () => {
    await lead("X", [["template_bot", day("09:00")]]);
    await lead("Y", [["template_bot", day("09:00")]]);
    const [uSdr, uGestor] = ["00000000-0000-0000-0000-00000000000a", "00000000-0000-0000-0000-00000000000b"];
    await db.exec(`insert into auth.users (id) values ('${uSdr}'), ('${uGestor}');
      insert into painel.profiles (id, name, role, sdr_id) values ('${uSdr}', 'X', 'sdr', '${sdr.X}');
      insert into painel.profiles (id, name, role) values ('${uGestor}', 'G', 'gestor');`);
    const como = async (u: string) => {
      await db.exec(`select set_config('request.jwt.claims', '{"role":"authenticated"}', false);
                     select set_config('request.jwt.claim.sub', '${u}', false); set role authenticated;`);
      try {
        return (await db.query<{ name: string }>("select name from painel.sdr_modelo_numeros($1, $2)", [FROM, TO])).rows.map((r) => r.name);
      } finally {
        await db.exec(`reset role; select set_config('request.jwt.claims', '{"role":"service_role"}', false);
                       select set_config('request.jwt.claim.sub', '', false);`);
      }
    };
    expect(await como(uSdr)).toEqual(["SDR X"]);
    expect(await como(uGestor)).toEqual(["SDR X", "SDR Y"]);
  });
});

describe("aderência", () => {
  const versao = async (n: number, criada: string, comps: object[]) =>
    db.query("insert into painel.sdr_ideal_versoes (versao, created_at, origem, comportamentos) values ($1, $2, 'edicao', $3)",
      [n, criada, JSON.stringify(comps)]);
  const num = (id: string, lo: number | null, hi: number | null, melhor: number, peso: number, ativo = true) =>
    ({ id, grupo: "num", nome: id, lo, hi, melhor, peso, ativo });

  it("dentro, melhor, fora, amostra pequena e a nota pelos pesos avaliados", async () => {
    for (let i = 0; i < 4; i++) await lead("X", [["template_bot", day("09:00")], ["lead", day("09:05")]]);
    for (let i = 0; i < 6; i++) await lead("X", [["template_bot", day("09:00")]]);
    await versao(1, day("00:00", "01"), [
      num("vol", 2, 5, 1, 10),       // 10 por dia: acima, mas maior é melhor → melhor
      num("tax", 50, 60, 1, 20),     // 40%: abaixo → fora
      num("des", 0, 10, 0, 30),      // 0%: dentro
      num("val", 1, 5, 1, 40),       // sem reunião → amostra pequena (fora da nota)
      num("conf", null, null, 1, 5), // sem faixa → sem dado
      num("res", 1, 2, -1, 50, false), // desligado: não aparece
      { id: "per", grupo: "ia", nome: "Perguntas", lo: 7, hi: 9, melhor: 1, peso: 5, ativo: true }, // IA fica para a 9c
    ]);
    const r = (await db.query<{ comportamento: string; situacao: string; aderencia: number; versao: number }>(
      "select * from painel.sdr_modelo_aderencia($1, $2) where name = 'SDR X'", [FROM, TO])).rows;
    expect(Object.fromEntries(r.map((x) => [x.comportamento, x.situacao]))).toEqual({
      vol: "melhor", tax: "abaixo", des: "dentro", val: "amostra_pequena", conf: "sem_dado",
    });
    // (10 + 30) ÷ (10 + 20 + 30) = 67
    expect(r[0].aderencia).toBe(67);
    expect(r[0].versao).toBe(1);
  });

  it("usa a versão em uso no fim do período (ou a primeira, se o período é anterior)", async () => {
    await lead("X", [["template_bot", day("09:00")]]);
    await versao(1, day("00:00", "01"), [num("vol", 0, 0.5, 0, 10)]);
    await versao(2, day("12:00", "05"), [num("vol", 0, 5, 0, 10)]);
    await versao(3, day("12:00", "08"), [num("vol", 3, 5, 0, 10)]);
    const em = async (de: string, ate: string) =>
      (await db.query<{ versao: number; situacao: string }>(
        "select versao, situacao from painel.sdr_modelo_aderencia($1, $2) where name = 'SDR X'", [de, ate])).rows[0];
    expect(await em(FROM, TO)).toEqual({ versao: 2, situacao: "dentro" });
    expect(await em(day("00:00", "01"), day("12:00", "01"))).toMatchObject({ versao: 1 });
    await db.query("delete from painel.sdr_ideal_versoes where versao = 1");
    expect(await em(day("00:00", "01"), day("12:00", "01"))).toMatchObject({ versao: 2 });
  });
});

describe("faixas da 1ª versão", () => {
  it("sem 3 SDRs com 3 reuniões ou mais, as faixas ficam vazias; os de conversa vêm desligados", async () => {
    const r = (await db.query<{ j: { id: string; lo: number | null; ativo: boolean }[] }>(
      "select painel.sdr_ideal_faixas_dos_melhores($1, $2) j", [FROM, TO])).rows[0].j;
    expect(r.map((c) => c.id)).toEqual(["vol", "pri", "res", "tax", "des", "val", "conf", "per", "gat"]);
    expect(r.filter((c) => c.ativo).every((c) => c.lo === null)).toBe(true);
    expect(r.find((c) => c.id === "per")!.ativo).toBe(false);
  });
});

describe("exemplos de conversas", () => {
  const ex = async (c: string) => (await db.query<{ tipo: string; lead_name: string; segundos: number | null; status: string | null }>(
    "select tipo, lead_name, segundos, status from painel.sdr_modelo_exemplos($1, $2, $3, $4)", [sdr.X, FROM, TO, c])).rows;

  it("1ª resposta: as 3 mais lentas a melhorar e a mais rápida como bom exemplo", async () => {
    const minutos = [2, 30, 10, 5, 1];
    for (const m of minutos) {
      await lead("X", [["template_bot", day("09:00")], ["lead", day("10:00")], ["sdr", day(`10:${String(m).padStart(2, "0")}`)]]);
    }
    await db.query("update painel.settings set value = 'false'::jsonb where key = 'metrics_business_only'");
    const r = await ex("pri");
    expect(r.filter((x) => x.tipo === "melhorar").map((x) => x.segundos)).toEqual([1800, 600, 300]);
    expect(r.filter((x) => x.tipo === "bom").map((x) => x.segundos)).toEqual([60]);
    expect(await ex("vol")).toEqual([]);
  });

  it("confirmação: reuniões sem mensagem na hora antes × com; a flash fica fora", async () => {
    const a = await lead("X", [["lead", day("09:00")], ["sdr", day("13:40")]]);
    const b = await lead("X", [["lead", day("09:00")]]);
    await reuniao("X", a, "validada", day("14:00"), day("10:00", "04"));
    await reuniao("X", b, "noshow", day("15:00"), day("10:00", "04"));
    await reuniao("X", b, "invalidada", day("16:00"), day("15:50"));
    const r = await ex("conf");
    expect(r.map((x) => [x.tipo, x.status])).toEqual([["melhorar", "sem_confirmacao"], ["bom", "confirmou"]]);
    expect((await ex("val")).map((x) => [x.tipo, x.status])).toEqual([["melhorar", "invalidada"], ["melhorar", "noshow"], ["bom", "validada"]]);
  });

  it("o SDR não vê exemplos de outro SDR", async () => {
    const u = "00000000-0000-0000-0000-00000000000c";
    await db.exec(`insert into auth.users (id) values ('${u}');
      insert into painel.profiles (id, name, role, sdr_id) values ('${u}', 'Y', 'sdr', '${sdr.Y}');
      select set_config('request.jwt.claims', '{"role":"authenticated"}', false);
      select set_config('request.jwt.claim.sub', '${u}', false); set role authenticated;`);
    try {
      await expect(db.query("select * from painel.sdr_modelo_exemplos($1, $2, $3, 'pri')", [sdr.X, FROM, TO])).rejects.toThrow(/acesso negado/);
    } finally {
      await db.exec(`reset role; select set_config('request.jwt.claims', '{"role":"service_role"}', false);
                     select set_config('request.jwt.claim.sub', '', false);`);
    }
  });
});

describe("salvar o SDR Ideal", () => {
  const comps = (pesoVol: number, extra: object = {}) => JSON.stringify([
    { id: "vol", grupo: "num", nome: "Volume", lo: 10, hi: 20, melhor: 1, peso: pesoVol, ativo: true, ...extra },
    { id: "tax", grupo: "num", nome: "Taxa", lo: 10, hi: 20, melhor: 1, peso: 100 - pesoVol, ativo: true },
    { id: "per", grupo: "ia", nome: "Perguntas", lo: 7, hi: 9, melhor: 1, peso: 5, ativo: false, descricao: "" },
  ]);
  const uG = "00000000-0000-0000-0000-0000000000d1", uS = "00000000-0000-0000-0000-0000000000d2";
  const como = async (u: string, base: number | null, json: string) => {
    await db.exec(`select set_config('request.jwt.claims', '{"role":"authenticated"}', false);
                   select set_config('request.jwt.claim.sub', '${u}', false); set role authenticated;`);
    try {
      return (await db.query<{ v: number }>("select painel.salvar_sdr_ideal($1, $2::jsonb, $3) v", [base, json, ["mudou"]])).rows[0].v;
    } finally {
      await db.exec(`reset role; select set_config('request.jwt.claims', '{"role":"service_role"}', false);
                     select set_config('request.jwt.claim.sub', '', false);`);
    }
  };
  beforeEach(async () => {
    await db.exec(`insert into auth.users (id) values ('${uG}'), ('${uS}');
      insert into painel.profiles (id, name, role) values ('${uG}', 'Gestor', 'gestor');
      insert into painel.profiles (id, name, role, sdr_id) values ('${uS}', 'SDR', 'sdr', '${sdr.X}');
      insert into painel.sdr_ideal_versoes (versao, origem, comportamentos) values (1, 'inicial', '[]');`);
  });

  it("gestor salva: versão nova com autor", async () => {
    expect(await como(uG, 1, comps(40))).toBe(2);
    const r = (await db.query<{ created_by: string; origem: string }>("select created_by, origem from painel.sdr_ideal_versoes where versao = 2")).rows[0];
    expect(r).toEqual({ created_by: uG, origem: "edicao" });
  });

  it("recusa: SDR, soma diferente de 100, faixa invertida, número novo, IA ativa sem critério e versão desatualizada", async () => {
    await expect(como(uS, 1, comps(40))).rejects.toThrow(/acesso negado/);
    await expect(como(uG, 1, JSON.stringify([{ id: "vol", grupo: "num", nome: "Volume", lo: 1, hi: 2, melhor: 1, peso: 90, ativo: true }]))).rejects.toThrow(/somam 90/);
    await expect(como(uG, 1, comps(40, { lo: 30 }))).rejects.toThrow(/"de" maior/);
    await expect(como(uG, 1, comps(40, { id: "novo" }))).rejects.toThrow(/precisa de código/);
    await expect(como(uG, 1, comps(40).replace('"ativo":false', '"ativo":true').replace('"peso":60', '"peso":55'))).rejects.toThrow(/o que a IA olha/);
    expect(await como(uG, 1, comps(40))).toBe(2);
    await expect(como(uG, 1, comps(50))).rejects.toThrow(/Outra pessoa salvou a versão 2/);
  });
});
