"use server";

import { redirect } from "next/navigation";
import { createClient, getMe } from "@/lib/supabase/server";

export async function definirSenha(form: FormData) {
  const senha = String(form.get("senha") ?? "");
  const confirma = String(form.get("confirma") ?? "");
  if (senha.length < 8) redirect(`/definir-senha?erro=${encodeURIComponent("A senha precisa ter pelo menos 8 caracteres.")}`);
  if (senha !== confirma) redirect(`/definir-senha?erro=${encodeURIComponent("As duas senhas não são iguais.")}`);
  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password: senha });
  if (error) {
    const msg = /different from the old/i.test(error.message) ? "A senha nova precisa ser diferente da anterior." : "Não foi possível salvar a senha. Tente de novo.";
    redirect(`/definir-senha?erro=${encodeURIComponent(msg)}`);
  }
  // Cada um entra na própria tela (mesma regra do login).
  const me = await getMe();
  redirect(me?.role === "sdr" && me.sdrId ? `/sdr/${me.sdrId}` : me?.role === "closer" ? "/agenda" : "/");
}
