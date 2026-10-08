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

  const archive = String(form.get("google_archive_calendar_id") ?? "").trim();
  if (archive && !/^[^\s@]+@(group\.calendar\.google\.com|poli\.digital)$/.test(archive)) {
    return back("O ID da agenda de arquivo deve terminar em @group.calendar.google.com (Google Agenda → Configurações da agenda → Integrar agenda).");
  }

  const db = (await createClient()).schema("painel");
  const now = new Date().toISOString();
  const steps = [
    db.from("business_hours").upsert(hours.map((h) => ({ weekday: h.weekday, enabled: h.enabled, start_time: h.start_time, end_time: h.end_time }))),
    db.from("settings").upsert([
      { key: "stale_minutes", value: stale, updated_at: now, updated_by: me!.id },
      { key: "stale_business_only", value: form.get("stale_business_only") === "on", updated_at: now, updated_by: me!.id },
      { key: "metrics_business_only", value: form.get("metrics_business_only") === "on", updated_at: now, updated_by: me!.id },
      { key: "holidays_off", value: form.get("holidays_off") === "on", updated_at: now, updated_by: me!.id },
      { key: "google_archive_calendar_id", value: archive, updated_at: now, updated_by: me!.id },
      { key: "google_invite_sdr", value: form.get("google_invite_sdr") === "on", updated_at: now, updated_by: me!.id },
      { key: "reuse_window", value: form.get("reuse_window") === "30d" ? "30d" : "mes", updated_at: now, updated_by: me!.id },
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

interface QualityCriterion { id: string | null; name: string; description: string; weight: number }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Critérios e contexto da nota de qualidade (Fase 7c). Critério removido é desativado, não apagado: as notas antigas
// continuam mostrando o nome dele. Qualquer mudança gera uma versão nova e o worker avalia os leads de novo.
export async function saveQuality(form: FormData) {
  const me = await getMe();
  if (me?.role !== "admin") back("Só o administrador pode alterar as configurações.");

  let list: QualityCriterion[];
  try {
    list = JSON.parse(String(form.get("criteria")));
    if (!Array.isArray(list)) throw new Error();
  } catch {
    return back("Não foi possível ler o formulário. Recarregue a página e tente de novo.");
  }
  const context = String(form.get("quality_context") ?? "").trim();
  if (!context) return back("Escreva o contexto para o Claude.");
  if (context.length > 3000) return back("O contexto pode ter até 3.000 caracteres.");
  if (!list.length) return back("Mantenha pelo menos um critério.");
  if (list.length > 8) return back("Use no máximo 8 critérios.");
  const rows = list.map((c, i) => ({
    id: typeof c.id === "string" && UUID.test(c.id) ? c.id : null,
    name: String(c.name ?? "").trim(),
    description: String(c.description ?? "").trim(),
    weight: Number(c.weight),
    sort: i + 1,
  }));
  for (const c of rows) {
    if (!c.name || c.name.length > 60) return back("Cada critério precisa de um nome de até 60 caracteres.");
    if (!c.description || c.description.length > 600) return back(`Descreva o que o Claude deve observar em "${c.name}" (até 600 caracteres).`);
    if (!Number.isInteger(c.weight) || c.weight < 1 || c.weight > 10) return back(`O peso de "${c.name}" precisa ser um número de 1 a 10.`);
  }
  if (new Set(rows.map((c) => c.name.toLowerCase())).size !== rows.length) return back("Há dois critérios com o mesmo nome.");

  const db = (await createClient()).schema("painel");
  const current = await db.from("quality_criteria").select("id").eq("active", true);
  if (current.error) return back(`Não foi possível ler os critérios: ${current.error.message}`);
  const keep = new Set(rows.flatMap((c) => (c.id ? [c.id] : [])));
  const removed = (current.data ?? []).map((c) => c.id).filter((id) => !keep.has(id));

  const steps = [
    ...rows.filter((c) => c.id).map(({ id, ...c }) => db.from("quality_criteria").update({ ...c, active: true }).eq("id", id!)),
    ...(rows.some((c) => !c.id) ? [db.from("quality_criteria").insert(rows.filter((c) => !c.id).map(({ id: _, ...c }) => c))] : []),
    ...(removed.length ? [db.from("quality_criteria").update({ active: false }).in("id", removed)] : []),
    db.from("settings").upsert({ key: "quality_context", value: context, updated_at: new Date().toISOString(), updated_by: me!.id }),
  ];
  for (const r of await Promise.all(steps)) if (r.error) return back(`Não foi possível salvar os critérios: ${r.error.message}`);
  back();
}
