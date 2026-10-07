// Início da conexão da agenda: só o closer logado, para a própria agenda. Leva ao Google com um "state"
// aleatório guardado num cookie (protege contra uma volta forjada).
import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { authUrl } from "@painel/shared/google";
import { APP_URL, googleCreds } from "@/lib/google";
import { createClient, getMe } from "@/lib/supabase/server";

export async function GET() {
  const me = await getMe();
  if (me?.role !== "closer") return NextResponse.redirect(`${APP_URL}/`);
  const { data } = await (await createClient()).auth.getUser();
  const state = randomBytes(24).toString("base64url");
  const res = NextResponse.redirect(authUrl(googleCreds(), state, data.user?.email ?? undefined));
  res.cookies.set("g_state", state, { httpOnly: true, secure: true, sameSite: "lax", path: "/api/google", maxAge: 600 });
  return res;
}
