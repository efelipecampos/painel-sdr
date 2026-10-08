// Confere automaticamente os itens de segurança do checklist de SQL (docs/COMECE-AQUI.md, seção 3).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDb } from "./db";

let db: PGlite;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

const CONFIG_TABLES = ["business_hours", "holidays", "quality_criteria", "settings"];
// Tabelas de carrossel que gestor e admin editam na tela. Carrossel não se apaga (arquivar = active false);
// closer pode ser removido do carrossel (o livro-caixa fica).

async function tables(): Promise<{ schema: string; name: string; rls: boolean }[]> {
  const res = await db.query<{ schema: string; name: string; rls: boolean }>(`
    select n.nspname as schema, c.relname as name, c.relrowsecurity as rls
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind = 'r' and n.nspname in ('public', 'painel')
    order by 1, 2
  `);
  return res.rows;
}

describe("segurança do banco", () => {
  it("todas as tabelas de public e painel têm RLS ligado", async () => {
    const all = await tables();
    expect(all.length).toBe(27);
    expect(all.filter((t) => !t.rls)).toEqual([]);
  });

  it("anon não tem nenhum privilégio em tabela nem em função", async () => {
    const t = await db.query(`
      select table_schema, table_name, privilege_type from information_schema.role_table_grants
      where grantee in ('anon', 'PUBLIC') and table_schema in ('public', 'painel')
    `);
    expect(t.rows).toEqual([]);
    const f = await db.query(`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'painel' and has_function_privilege('anon', p.oid, 'execute')
    `);
    expect(f.rows).toEqual([]);
  });

  it("authenticated só acessa profiles (leitura), as tabelas de configuração e as de carrossel", async () => {
    const res = await db.query<{ table_name: string; privilege_type: string }>(`
      select table_name, privilege_type from information_schema.role_table_grants
      where grantee = 'authenticated' and table_schema in ('public', 'painel')
      order by 1, 2
    `);
    const byTable = new Map<string, string[]>();
    for (const r of res.rows) byTable.set(r.table_name, [...(byTable.get(r.table_name) ?? []), r.privilege_type]);
    expect([...byTable.keys()].sort()).toEqual([...CONFIG_TABLES, "carousel_members", "carousels", "profiles"].sort());
    expect(byTable.get("carousels")).toEqual(["INSERT", "SELECT", "UPDATE"]);
    expect(byTable.get("carousel_members")).toEqual(["DELETE", "INSERT", "SELECT", "UPDATE"]);
    expect(byTable.get("profiles")).toEqual(["SELECT"]);
    for (const t of CONFIG_TABLES) expect(byTable.get(t)).toEqual(["DELETE", "INSERT", "SELECT", "UPDATE"]);
  });

  it("service_role acessa tudo que a integração e o worker usam, inclusive sequências", async () => {
    for (const t of await tables()) {
      const res = await db.query<{ ok: boolean }>(
        "select has_table_privilege('service_role', $1, 'select, insert, update') as ok",
        [`${t.schema}.${t.name}`],
      );
      expect(res.rows[0].ok, `${t.schema}.${t.name}`).toBe(true);
    }
    const seqs = await db.query<{ name: string; ok: boolean }>(`
      select n.nspname || '.' || c.relname as name, has_sequence_privilege('service_role', c.oid, 'usage') as ok
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'S' and n.nspname in ('public', 'painel')
    `);
    expect(seqs.rows.length).toBeGreaterThan(0);
    expect(seqs.rows.filter((s) => !s.ok)).toEqual([]);
  });

  it("só admin ativo edita configurações; gestor só lê", async () => {
    const admin = "00000000-0000-0000-0000-000000000001";
    const gestor = "00000000-0000-0000-0000-000000000002";
    await db.exec(`
      insert into auth.users (id) values ('${admin}'), ('${gestor}');
      insert into painel.profiles (id, name, role) values ('${admin}', 'Admin', 'admin'), ('${gestor}', 'Gestor', 'gestor');
    `);

    async function asUser<T>(uid: string, sql: string): Promise<T[]> {
      await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${uid}', false);`);
      try {
        return (await db.query<T>(sql)).rows;
      } finally {
        await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`);
      }
    }

    expect((await asUser(gestor, "select * from painel.business_hours")).length).toBe(7);
    await asUser(gestor, "update painel.settings set value = '99' where key = 'stale_minutes'");
    expect((await db.query<{ v: number }>("select value as v from painel.settings where key = 'stale_minutes'")).rows[0].v).toBe(30);

    await asUser(admin, "update painel.settings set value = '45' where key = 'stale_minutes'");
    expect((await db.query<{ v: number }>("select value as v from painel.settings where key = 'stale_minutes'")).rows[0].v).toBe(45);

    await expect(asUser(gestor, "select * from painel.chats")).rejects.toThrow(/permission denied/);
  });
});
