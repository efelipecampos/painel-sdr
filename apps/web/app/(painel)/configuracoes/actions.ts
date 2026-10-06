"use server";

// Grava as configurações com a sessão do usuário. Só admin consegue: o RLS do banco recusa os outros.
import { redirect } from "next/navigation";
import { createClient, getMe } from "@/lib/supabase/server";

interface Hour { weekday: number; enabled: boolean; start_time: string; end_time: string }
interface Holiday { day: string; name: string }

const back = (msg?: string) => redirect(msg ? `/configuracoes?erro=${encodeURIComponent(msg)}` : "/configuracoes?salvo=1");

export async function saveSettings(form: FormData) {
  const me = await getMe();
  if (me?.role !== "admin") back("Só o administrador pode alterar as configurações.");

  let hours: Hour[];
  let holidays: Holiday[];
  try {
    hours = JSON.parse(String(form.get("hours")));
    holidays = JSON.parse(String(form.get("holidays")));
  } catch {
    return back("Não foi possível ler o formulário. Recarregue a página e tente de novo.");
  }
  for (const h of hours) {
    if (h.enabled && !(h.end_time > h.start_time)) return back("Em cada dia aberto, o fim do expediente precisa ser depois do início.");
  }
  const stale = Number(form.get("stale_minutes"));
  if (!Number.isInteger(stale) || stale < 1 || stale > 1440) return back("O limite de parado precisa ser um número de 1 a 1440 minutos.");

  const db = (await createClient()).schema("painel");
  const now = new Date().toISOString();
  const steps = [
    db.from("business_hours").upsert(hours.map((h) => ({ weekday: h.weekday, enabled: h.enabled, start_time: h.start_time, end_time: h.end_time }))),
    db.from("settings").upsert([
      { key: "stale_minutes", value: stale, updated_at: now, updated_by: me!.id },
      { key: "stale_business_only", value: form.get("stale_business_only") === "on", updated_at: now, updated_by: me!.id },
      { key: "metrics_business_only", value: form.get("metrics_business_only") === "on", updated_at: now, updated_by: me!.id },
      { key: "holidays_off", value: form.get("holidays_off") === "on", updated_at: now, updated_by: me!.id },
    ]),
  ];
  for (const r of await Promise.all(steps)) if (r.error) return back(`Não foi possível salvar: ${r.error.message}`);

  // Feriados: grava a lista da tela (apaga os removidos, inclui os novos).
  const current = await db.from("holidays").select("day");
  if (current.error) return back(`Não foi possível salvar os feriados: ${current.error.message}`);
  const keep = new Set(holidays.map((x) => x.day));
  const removed = (current.data ?? []).map((x) => x.day).filter((d) => !keep.has(d));
  if (removed.length) {
    const del = await db.from("holidays").delete().in("day", removed);
    if (del.error) return back(`Não foi possível remover feriados: ${del.error.message}`);
  }
  if (holidays.length) {
    const up = await db.from("holidays").upsert(holidays);
    if (up.error) return back(`Não foi possível salvar os feriados: ${up.error.message}`);
  }
  back();
}
