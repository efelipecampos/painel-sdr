// Link dos e-mails de convite e de "esqueci minha senha" (templates do Supabase Auth apontam para cá).
// Confere o token, abre a sessão e leva para a página de criar a senha.
import type { EmailOtpType } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";
import { APP_URL } from "@/lib/google";
import { createClient } from "@/lib/supabase/server";

const TIPOS: EmailOtpType[] = ["invite", "recovery"];

export async function GET(request: NextRequest) {
  const tokenHash = request.nextUrl.searchParams.get("token_hash");
  const type = request.nextUrl.searchParams.get("type") as EmailOtpType | null;
  // Endereço público do painel (dentro do container, a URL da requisição é 0.0.0.0:3000).
  if (tokenHash && type && TIPOS.includes(type)) {
    const { error } = await (await createClient()).auth.verifyOtp({ token_hash: tokenHash, type });
    if (!error) redirect(`${APP_URL}/definir-senha`);  // redirect() leva os cookies da sessão nova
  }
  redirect(`${APP_URL}/login?erro=${encodeURIComponent("Esse link expirou ou já foi usado. Peça um novo em \"Esqueci minha senha\".")}`);
}
