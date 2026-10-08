"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { clientIp, LoginLimiter } from "@/lib/login-limit";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

const limiter = new LoginLimiter();

export async function signIn(form: FormData) {
  const email = String(form.get("email") ?? "").trim();
  const password = String(form.get("password") ?? "");
  const h = await headers();
  const ip = clientIp(h.get("x-forwarded-for"), h.get("x-real-ip"));
  const wait = limiter.blockedFor(email, ip);
  if (wait) redirect(`/login?erro=${encodeURIComponent(`Muitas tentativas erradas. Tente de novo em ${wait} min.`)}`);
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    limiter.fail(email, ip);
    redirect(`/login?erro=${encodeURIComponent("E-mail ou senha incorretos.")}`);
  }
  limiter.success(email);
  // Cada um entra na própria tela: SDR na lista dele, closer na agenda; gestor e admin no painel do time.
  const { data: p } = await createAdminClient().schema("painel").from("profiles").select("role, sdr_id").eq("id", data.user.id).maybeSingle();
  redirect(p?.role === "sdr" && p.sdr_id ? `/sdr/${p.sdr_id}` : p?.role === "closer" ? "/agenda" : "/");
}
