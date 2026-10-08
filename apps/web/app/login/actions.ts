"use server";

import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export async function signIn(form: FormData) {
  const email = String(form.get("email") ?? "").trim();
  const password = String(form.get("password") ?? "");
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) redirect(`/login?erro=${encodeURIComponent("E-mail ou senha incorretos.")}`);
  // Cada um entra na própria tela: SDR na lista dele, closer na agenda; gestor e admin no painel do time.
  const { data: p } = await createAdminClient().schema("painel").from("profiles").select("role, sdr_id").eq("id", data.user.id).maybeSingle();
  redirect(p?.role === "sdr" && p.sdr_id ? `/sdr/${p.sdr_id}` : p?.role === "closer" ? "/agenda" : "/");
}
