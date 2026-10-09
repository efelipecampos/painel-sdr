// Tela Usuários (2026-10-09): adicionar usuário (o servidor cria o login e chama cadastrar_usuario) e trocar papel.
// Só admin e quem tem a marcação; admin só por admin; ninguém muda o próprio papel.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDb } from "./db";

let db: PGlite;
const uid = {
  admin: "00000000-0000-0000-0000-0000000003a1",
  timoteo: "00000000-0000-0000-0000-0000000003a2",
  iago: "00000000-0000-0000-0000-0000000003a3",
  novoSdr: "00000000-0000-0000-0000-0000000003a4",
  novoCloser: "00000000-0000-0000-0000-0000000003a5",
  novoGestor: "00000000-0000-0000-0000-0000000003a6",
};
let sdrExistente = "";

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
const perfil = async (id: string) =>
  (await db.query<{ role: string; sdr_id: string | null; active: boolean; name: string }>("select role, sdr_id, active, name from painel.profiles where id = $1", [id])).rows[0];
const atendente = async (email: string) =>
  (await db.query<{ id: string; role: string; role_pela_tela: boolean }>("select id, role, role_pela_tela from painel.sdrs where poli_email = $1", [email])).rows[0];

beforeAll(async () => {
  db = await createTestDb();
  await db.exec(`select set_config('request.jwt.claims', '{"role":"service_role"}', false);`);
  sdrExistente = (await db.query<{ id: string }>("insert into painel.sdrs (poli_email, name, role) values ('jessica@poli.digital', 'Jessica', 'sdr') returning id")).rows[0].id;
  await db.query(`insert into auth.users (id, email) values ($1, 'felipe@poli.digital'), ($2, 'timoteo@poli.digital'), ($3, 'iago@poli.digital'),
                  ($4, 'Jessica@poli.digital'), ($5, 'calil@poli.digital'), ($6, 'gui@poli.digital')`,
    [uid.admin, uid.timoteo, uid.iago, uid.novoSdr, uid.novoCloser, uid.novoGestor]);
  await db.query(`insert into painel.profiles (id, name, role, can_manage_users) values
                  ($1, 'Felipe', 'admin', false), ($2, 'Timóteo', 'gestor', true), ($3, 'Iago', 'gestor', false)`, [uid.admin, uid.timoteo, uid.iago]);
});

afterAll(async () => {
  await db.close();
});

describe("adicionar usuário (servidor)", () => {
  it("SDR que já atende na Poli: liga ao atendente pelo e-mail e trava o papel da tela", async () => {
    await db.query("select painel.cadastrar_usuario($1, 'Jessica', 'sdr')", [uid.novoSdr]);
    expect(await perfil(uid.novoSdr)).toMatchObject({ role: "sdr", sdr_id: sdrExistente, active: true });
    expect(await atendente("jessica@poli.digital")).toMatchObject({ role: "sdr", role_pela_tela: true });
  });
  it("closer que ainda não apareceu na Poli: cria o atendente", async () => {
    await db.query("select painel.cadastrar_usuario($1, 'Calil', 'closer')", [uid.novoCloser]);
    const a = await atendente("calil@poli.digital");
    expect(a).toMatchObject({ role: "closer", role_pela_tela: true });
    expect(await perfil(uid.novoCloser)).toMatchObject({ role: "closer", sdr_id: a.id });
  });
  it("gestor: sem atendente ligado; quem já tem acesso não é cadastrado de novo", async () => {
    await db.query("select painel.cadastrar_usuario($1, 'Guilherme', 'gestor')", [uid.novoGestor]);
    expect(await perfil(uid.novoGestor)).toMatchObject({ role: "gestor", sdr_id: null });
    await expect(db.query("select painel.cadastrar_usuario($1, 'Guilherme', 'gestor')", [uid.novoGestor])).rejects.toThrow(/já tem acesso/);
    await expect(db.query("select painel.cadastrar_usuario($1, ' ', 'sdr')", [uid.iago])).rejects.toThrow(/falta o nome/);
  });
  it("usuário logado não chama cadastrar_usuario nem login_do_email", async () => {
    await expect(as(uid.admin, "select painel.cadastrar_usuario($1, 'X', 'sdr')", [uid.iago])).rejects.toThrow(/permission denied/);
    await expect(as(uid.admin, "select painel.login_do_email('iago@poli.digital')")).rejects.toThrow(/permission denied/);
    expect((await db.query<{ id: string }>("select painel.login_do_email(' IAGO@poli.digital ') as id")).rows[0].id).toBe(uid.iago);
  });
});

describe("trocar papel", () => {
  it("SDR vira closer e volta; o atendente acompanha", async () => {
    await as(uid.timoteo, "select painel.definir_papel($1, $2, 'closer')", [sdrExistente, uid.novoSdr]);
    expect(await perfil(uid.novoSdr)).toMatchObject({ role: "closer", sdr_id: sdrExistente });
    expect(await atendente("jessica@poli.digital")).toMatchObject({ role: "closer" });
    await as(uid.timoteo, "select painel.definir_papel($1, $2, 'sdr')", [sdrExistente, uid.novoSdr]);
    expect(await perfil(uid.novoSdr)).toMatchObject({ role: "sdr" });
  });
  it("gestor sem atendente vira SDR: cria o atendente; e volta a gestor sem sdr_id", async () => {
    await as(uid.admin, "select painel.definir_papel(null, $1, 'sdr')", [uid.novoGestor]);
    const a = await atendente("gui@poli.digital");
    expect(a).toMatchObject({ role: "sdr", role_pela_tela: true });
    expect(await perfil(uid.novoGestor)).toMatchObject({ role: "sdr", sdr_id: a.id });
    await as(uid.admin, "select painel.definir_papel($1, $2, 'gestor')", [a.id, uid.novoGestor]);
    expect(await perfil(uid.novoGestor)).toMatchObject({ role: "gestor", sdr_id: null });
    expect(await atendente("gui@poli.digital")).toMatchObject({ role: "gestor" });
  });
  it("atendente sem login: troca só o papel do atendente; admin precisa de login", async () => {
    const id = (await db.query<{ id: string }>("insert into painel.sdrs (poli_email, name, role) values ('bia@poli.digital', 'Bia', 'sdr') returning id")).rows[0].id;
    await as(uid.timoteo, "select painel.definir_papel($1, null, 'closer')", [id]);
    expect(await atendente("bia@poli.digital")).toMatchObject({ role: "closer", role_pela_tela: true });
    await expect(as(uid.admin, "select painel.definir_papel($1, null, 'admin')", [id])).rejects.toThrow(/precisa de login/);
  });
  it("só admin dá ou tira admin; ninguém muda o próprio papel; gestor sem marcação e SDR não mudam nada", async () => {
    await expect(as(uid.timoteo, "select painel.definir_papel(null, $1, 'admin')", [uid.iago])).rejects.toThrow(/só o administrador/);
    await expect(as(uid.timoteo, "select painel.definir_papel(null, $1, 'gestor')", [uid.admin])).rejects.toThrow(/só o administrador/);
    await expect(as(uid.admin, "select painel.definir_papel(null, $1, 'gestor')", [uid.admin])).rejects.toThrow(/próprio papel/);
    await expect(as(uid.iago, "select painel.definir_papel(null, $1, 'sdr')", [uid.timoteo])).rejects.toThrow(/acesso negado/);
    await expect(as(uid.novoSdr, "select painel.definir_papel(null, $1, 'admin')", [uid.novoSdr])).rejects.toThrow(/acesso negado/);
    await as(uid.admin, "select painel.definir_papel(null, $1, 'admin')", [uid.iago]);
    expect(await perfil(uid.iago)).toMatchObject({ role: "admin" });
    await as(uid.admin, "select painel.definir_papel(null, $1, 'gestor')", [uid.iago]);
    expect(await perfil(uid.iago)).toMatchObject({ role: "gestor" });
  });
});
