// Volta do Google: confere o state, troca o código pela autorização, confere que a conta conectada é a
// mesma do closer (e-mail da Poli) e guarda a autorização cifrada.
import { NextResponse, type NextRequest } from "next/server";
import { GoogleError, encryptToken, exchangeCode } from "@painel/shared/google";
import { APP_URL, googleCreds, logCalendar, tokenKey } from "@/lib/google";
import { createAdminClient } from "@/lib/supabase/admin";
import { getMe } from "@/lib/supabase/server";

const back = (msg?: string) => {
  const res = NextResponse.redirect(`${APP_URL}/agenda${msg ? `?erro=${encodeURIComponent(msg)}` : "?conectada=1"}`);
  res.cookies.delete({ name: "g_state", path: "/api/google" });
  return res;
};

export async function GET(req: NextRequest) {
  const me = await getMe();
  if (me?.role !== "closer" || !me.sdrId) return NextResponse.redirect(`${APP_URL}/`);
  const q = req.nextUrl.searchParams;
  const state = req.cookies.get("g_state")?.value;
  if (!state || q.get("state") !== state) return back("A conexão expirou. Clique em Conectar de novo.");
  if (q.get("error")) return back("Você não autorizou o acesso à agenda. Para receber reuniões, clique em Conectar e autorize.");
  const code = q.get("code");
  if (!code) return back("O Google não devolveu a autorização. Tente de novo.");

  const db = createAdminClient().schema("painel");
  try {
    const conn = await exchangeCode(googleCreds(), code);
    const { data: closer } = await db.from("sdrs").select("poli_email").eq("id", me.sdrId).single();
    if (conn.email !== String(closer?.poli_email ?? "").toLowerCase()) {
      await logCalendar({ closer_id: me.sdrId, op: "conectar", ok: false, reason: "conta_diferente" });
      return back(`Conecte com a sua conta da Poli (${closer?.poli_email}). A conta escolhida no Google era outra.`);
    }
    const now = new Date().toISOString();
    const up = await db.from("google_connections").upsert({
      closer_id: me.sdrId, google_email: conn.email, refresh_token_enc: encryptToken(conn.refreshToken, tokenKey()),
      scopes: conn.scopes, status: "conectada", connected_at: now, last_ok_at: now, last_error: null, updated_at: now,
    });
    if (up.error) throw new Error(up.error.message);
    await logCalendar({ closer_id: me.sdrId, op: "conectar", ok: true });
    return back();
  } catch (e) {
    const g = e instanceof GoogleError ? e : null;
    await logCalendar({ closer_id: me.sdrId, op: "conectar", ok: false, http_status: g?.status ?? null, reason: g?.reason ?? "erro_interno" });
    if (g?.reason === "permissao_faltando") return back("Marque todas as permissões pedidas pelo Google (ver horários livres e criar eventos) e tente de novo.");
    return back("Não foi possível conectar a agenda. Tente de novo; se continuar, avise o administrador.");
  }
}
