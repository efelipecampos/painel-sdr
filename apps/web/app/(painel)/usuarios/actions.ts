"use server";

// Desativa/reativa e troca papel com a sessão do usuário. O banco confere quem pode (admin e quem tem a marcação).
// Adicionar usuário e mandar link de senha usam a service_role (só no servidor), depois de conferir quem pede.
import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient, getMe } from "@/lib/supabase/server";

export async function setUserActive(form: FormData) {
  if (!(await getMe())?.canManageUsers) redirect("/");
  const active = form.get("active") === "true";
  const { error } = await (await createClient()).schema("painel").rpc("definir_usuario_ativo", {
    p_sdr: String(form.get("sdr_id") || "") || null,
    p_profile: String(form.get("profile_id") || "") || null,
    p_active: active,
  });
  if (error) redirect(`/usuarios?erro=${encodeURIComponent(error.message)}`);
  redirect(`/usuarios?salvo=${active ? "on" : "off"}`);
}

const voltar = (q: Record<string, string>) => redirect(`/usuarios?${new URLSearchParams(q)}`);
const PAPEIS = ["admin", "gestor", "sdr", "closer"];

/**
 * Adicionar usuário: cria o login no Supabase Auth com convite por e-mail (o link leva a /definir-senha)
 * e cadastra o papel. Admin novo só por admin. E-mail que já tem login: só libera o acesso, sem convite.
 */
export async function adicionarUsuario(form: FormData) {
  const me = await getMe();
  if (!me?.canManageUsers) redirect("/");
  const nome = String(form.get("nome") ?? "").trim();
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const papel = String(form.get("papel") ?? "");
  if (!nome || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !PAPEIS.includes(papel)) voltar({ erro: "Preencha nome, e-mail e papel." });
  if (papel === "admin" && me.role !== "admin") voltar({ erro: "Só o administrador cria outro admin." });
  const admin = createAdminClient();
  const p = admin.schema("painel");
  const { data: existente } = await p.rpc("login_do_email", { p_email: email });
  let id = existente as string | null;
  if (!id) {
    const { data, error } = await admin.auth.admin.inviteUserByEmail(email, { data: { name: nome } });
    if (error || !data.user) voltar({ erro: `Não foi possível enviar o convite (${error?.message ?? "sem resposta"}). Confira o e-mail e a configuração de envio no Supabase.` });
    id = data.user!.id;
  }
  const { error } = await p.rpc("cadastrar_usuario", { p_user: id, p_nome: nome, p_papel: papel });
  if (error) voltar({ erro: `${nome}: ${error.message}.` });
  voltar({ salvo: existente ? "existente" : "convite" });
}

/** Troca de papel com a sessão de quem pede (o banco confere as regras). */
export async function definirPapel(form: FormData) {
  if (!(await getMe())?.canManageUsers) redirect("/");
  const { error } = await (await createClient()).schema("painel").rpc("definir_papel", {
    p_sdr: String(form.get("sdr_id") || "") || null,
    p_profile: String(form.get("profile_id") || "") || null,
    p_papel: String(form.get("papel") ?? ""),
  });
  if (error) voltar({ erro: error.message });
  voltar({ salvo: "papel" });
}

/** Manda de novo o link para criar senha: convite para quem nunca entrou, "senha nova" para quem já entrou. */
export async function enviarLinkSenha(form: FormData) {
  if (!(await getMe())?.canManageUsers) redirect("/");
  const admin = createAdminClient();
  const { data, error } = await admin.auth.admin.getUserById(String(form.get("profile_id") ?? ""));
  if (error || !data.user?.email) voltar({ erro: "Login não encontrado." });
  const email = data.user!.email!;
  let r = data.user!.last_sign_in_at ? null : (await admin.auth.admin.inviteUserByEmail(email)).error;
  if (data.user!.last_sign_in_at || r) r = (await admin.auth.resetPasswordForEmail(email)).error;
  if (r) voltar({ erro: `Não foi possível enviar o link (${r.message}).` });
  voltar({ salvo: "link" });
}
