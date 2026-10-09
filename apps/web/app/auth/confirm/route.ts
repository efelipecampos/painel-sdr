// Link dos e-mails de convite e de "esqueci minha senha" (templates do Supabase Auth apontam para cá).
// Confere o token, abre a sessão e leva para a página de criar a senha.
import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

const TIPOS: EmailOtpType[] = ["invite", "recovery"];

export async function GET(request: NextRequest) {
  const tokenHash = request.nextUrl.searchParams.get("token_hash");
  const type = request.nextUrl.searchParams.get("type") as EmailOtpType | null;
  const url = request.nextUrl.clone();
  url.search = "";
  if (tokenHash && type && TIPOS.includes(type)) {
    const { error } = await (await createClient()).auth.verifyOtp({ token_hash: tokenHash, type });
    if (!error) {
      url.pathname = "/definir-senha";
      return NextResponse.redirect(url);
    }
  }
  url.pathname = "/login";
  url.searchParams.set("erro", "Esse link expirou ou já foi usado. Peça um novo em \"Esqueci minha senha\".");
  return NextResponse.redirect(url);
}
