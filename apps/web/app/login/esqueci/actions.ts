"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { clientIp, LoginLimiter } from "@/lib/login-limit";
import { createClient } from "@/lib/supabase/server";

// Até 3 pedidos por e-mail e 10 por IP a cada 15 min.
const limiter = new LoginLimiter({ email: { max: 3, windowMs: 15 * 60_000 }, ip: { max: 10, windowMs: 15 * 60_000 } });

// Sempre a mesma resposta, exista ou não o e-mail (não revela quem tem acesso).
export async function esqueciSenha(form: FormData) {
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const h = await headers();
  const ip = clientIp(h.get("x-forwarded-for"), h.get("x-real-ip"));
  const wait = limiter.blockedFor(email, ip);
  if (wait) redirect(`/login/esqueci?erro=${encodeURIComponent(`Muitos pedidos. Tente de novo em ${wait} min.`)}`);
  limiter.fail(email, ip); // conta cada pedido: segura quem tenta disparar muitos e-mails
  if (email) await (await createClient()).auth.resetPasswordForEmail(email);
  redirect("/login/esqueci?enviado=1");
}
