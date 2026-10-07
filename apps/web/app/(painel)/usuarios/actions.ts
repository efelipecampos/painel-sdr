"use server";

// Desativa/reativa com a sessão do usuário. O banco confere quem pode (admin e quem tem a marcação).
import { redirect } from "next/navigation";
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
