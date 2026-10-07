"use server";

// Grava carrosséis e pesos com a sessão do usuário. O RLS do banco só deixa admin e gestor.
import { redirect } from "next/navigation";
import { createClient, getMe, isManager } from "@/lib/supabase/server";

const back = (id: string, msg?: string): never =>
  redirect(`/carrosseis?c=${id}${msg ? `&erro=${encodeURIComponent(msg)}` : "&salvo=1"}`);

async function guard() {
  if (!isManager(await getMe())) redirect("/");
  return (await createClient()).schema("painel");
}

export async function saveCarousel(form: FormData) {
  const db = await guard();
  const id = String(form.get("id"));
  const durations = String(form.get("durations") ?? "").split(/[,\s]+/).map(Number).filter((n) => Number.isInteger(n) && n >= 10 && n <= 240);
  if (!durations.length) back(id, "Informe ao menos uma duração entre 10 e 240 minutos.");
  const name = String(form.get("name") ?? "").trim();
  if (!name) back(id, "O nome é obrigatório.");
  const num = (k: string, min: number, max: number) => {
    const v = Number(form.get(k));
    if (!Number.isFinite(v) || v < min || v > max) back(id, `Valor inválido em ${k}.`);
    return v;
  };
  const up = await db.from("carousels").update({
    name,
    description: String(form.get("description") ?? "").trim() || null,
    brand: form.get("brand") === "chatshub" ? "chatshub" : "poli",
    balance_period: form.get("balance_period") === "week" ? "week" : "month",
    refund_noshow: form.get("refund_noshow") === "on",
    refund_cancelada: form.get("refund_cancelada") === "on",
    refund_invalidada: form.get("refund_invalidada") === "on",
    sticky_days: Math.round(num("sticky_days", 0, 365)),
    min_notice_minutes: Math.round(num("min_notice_hours", 0, 72) * 60),
    window_business_days: Math.round(num("window_business_days", 1, 60)),
    gap_minutes: Math.round(num("gap_minutes", 0, 120)),
    durations,
  }).eq("id", id);
  if (up.error) back(id, `Não foi possível salvar: ${up.error.message}`);

  let members: { closer_id: string; weight: number; active: boolean }[] = [];
  try {
    members = JSON.parse(String(form.get("members") ?? "[]"));
  } catch {
    back(id, "Não foi possível ler os closers. Recarregue a página.");
  }
  if (members.length) {
    const m = await db.from("carousel_members").upsert(
      members.map((x) => ({ carousel_id: id, closer_id: x.closer_id, weight: Math.max(0, Math.min(100, Math.round(x.weight))), active: !!x.active })),
    );
    if (m.error) back(id, `Não foi possível salvar os closers: ${m.error.message}`);
  }
  back(id);
}

export async function archiveCarousel(form: FormData) {
  const db = await guard();
  const id = String(form.get("id"));
  const r = await db.from("carousels").update({ active: form.get("active") === "true" }).eq("id", id);
  if (r.error) back(id, `Não foi possível arquivar: ${r.error.message}`);
  back(id);
}

export async function createCarousel(form: FormData) {
  const db = await guard();
  const brand = form.get("brand") === "chatshub" ? "chatshub" : "poli";
  const r = await db.from("carousels").insert({ brand, name: "Novo carrossel", sort: 99 }).select("id").single();
  if (r.error) redirect(`/carrosseis?erro=${encodeURIComponent(`Não foi possível criar: ${r.error.message}`)}`);
  redirect(`/carrosseis?c=${r.data!.id}`);
}
