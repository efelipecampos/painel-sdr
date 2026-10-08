"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { clientIp, LoginLimiter } from "@/lib/login-limit";
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
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    limiter.fail(email, ip);
    redirect(`/login?erro=${encodeURIComponent("E-mail ou senha incorretos.")}`);
  }
  limiter.success(email);
  redirect("/");
}
