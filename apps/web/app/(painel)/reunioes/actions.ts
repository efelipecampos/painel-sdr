"use server";

// Ações da tela Reuniões (Fase 10d.2): status (com arquivo no Google) e mudança de horário (mesmo evento).
// A permissão é conferida no banco (permissao_reuniao / definir_status_reuniao) com a sessão do usuário.
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { busyOf, freeAt, loadRules } from "@/lib/agendar";
import { loadMeeting, moveEvent, syncEventWithStatus } from "@/lib/reuniao-google";
import { checkManual, gridSlots, interval, windowDays } from "@/lib/slots";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { addDays, localToDate } from "@/lib/time";

const admin = () => createAdminClient().schema("painel");

async function permissao(id: string): Promise<string | null> {
  const { data } = await (await createClient()).schema("painel").rpc("permissao_reuniao", { p_id: id });
  return (data as string | null) ?? null;
}

export async function mudarStatus(id: string, status: string): Promise<{ erro?: string }> {
  const { error } = await (await createClient()).schema("painel").rpc("definir_status_reuniao", { p_id: id, p_status: status });
  if (error) return { erro: error.message.includes("acesso negado") ? "Você não pode alterar esta reunião." : error.message };
  revalidatePath("/reunioes");
  try {
    const m = await loadMeeting(id);
    if (m) await syncEventWithStatus(m);
  } catch (e) {
    return { erro: `Status salvo, mas a agenda do Google não foi atualizada: ${(e as Error).message}` };
  }
  return {};
}

/** Closers que podem ficar com a reunião no novo horário: os elegíveis do carrossel e o closer atual. */
async function candidatos(meetingId: string) {
  const m = await loadMeeting(meetingId);
  if (!m) throw new Error("Reunião não encontrada.");
  const { data: car } = await admin().from("meetings").select("carousel_id").eq("id", meetingId).single();
  const { data: eleg } = await admin().rpc("closers_elegiveis", { p_carousel: car!.carousel_id });
  const ids = new Set<string>([m.closer_id, ...((eleg ?? []) as { closer_id: string }[]).map((e) => e.closer_id)]);
  return { m, carouselId: car!.carousel_id as string, closers: [...ids] };
}

async function guard(id: string) {
  const p = await permissao(id);
  if (p !== "sdr" && p !== "gestor") throw new Error("Você não pode mudar o horário desta reunião.");
}

export async function diasReagendar(id: string): Promise<string[]> {
  await guard(id);
  const { carouselId } = await candidatos(id);
  return windowDays(new Date(), (await loadRules(carouselId)).rules);
}

export async function horariosReagendar(id: string, day: string, duration: number) {
  await guard(id);
  const { carouselId, closers } = await candidatos(id);
  const { carousel, rules } = await loadRules(carouselId);
  if (!windowDays(new Date(), rules).includes(day)) return [];
  const busy = await busyOf(closers, localToDate(`${day}T00:00`), localToDate(`${addDays(day, 1)}T00:00`), id);
  return gridSlots(day, duration, rules, new Date()).map((hhmm) => {
    const s = localToDate(`${day}T${hhmm}`);
    return { start: hhmm, count: freeAt(busy, s, new Date(s.getTime() + duration * 60_000), carousel.gap_minutes).length };
  });
}

export async function conferirReagendar(id: string, local: string, duration: number) {
  await guard(id);
  const { carouselId, closers } = await candidatos(id);
  const { carousel, rules } = await loadRules(carouselId);
  const check = checkManual(local, duration, rules, new Date());
  if (check.erro) return { ...check, count: 0 };
  const { start, end } = interval(local, duration);
  return { ...check, count: freeAt(await busyOf(closers, start, end, id), start, end, carousel.gap_minutes).length };
}

export async function reagendar(_: { erro?: string }, form: FormData): Promise<{ erro?: string }> {
  const id = String(form.get("id"));
  const local = String(form.get("local") ?? "");
  const duration = Number(form.get("duration"));
  try {
    await guard(id);
  } catch (e) {
    return { erro: (e as Error).message };
  }
  const { m: before, carouselId, closers } = await candidatos(id);
  const { carousel, rules } = await loadRules(carouselId);
  const check = checkManual(local, duration, rules, new Date());
  if (check.erro) return { erro: check.erro };
  const { start, end } = interval(local, duration);
  const livres = freeAt(await busyOf(closers, start, end, id), start, end, carousel.gap_minutes);
  if (!livres.length) return { erro: "Nenhum closer está livre neste horário agora. Escolha outro horário." };
  const r = await admin().rpc("reagendar_reuniao", { p_meeting: id, p_starts: start.toISOString(), p_ends: end.toISOString(), p_livres: livres });
  if (r.error) {
    return { erro: r.error.hint === "sem_closer_livre" ? "Nenhum closer está livre neste horário agora. Escolha outro horário." : `Não foi possível mudar o horário: ${r.error.message}` };
  }
  const me = (await (await createClient()).auth.getUser()).data.user?.id ?? null;
  const after = (await loadMeeting(id))!;
  // hubspot_sync_needed: o worker atualiza a Reunião no HubSpot (horário e closer) em seguida
  await admin().from("meetings").update({ fora_do_padrao: check.foraDoPadrao, hubspot_sync_needed: true }).eq("id", id);
  await admin().from("meeting_changes").insert({
    meeting_id: id, changed_by: me, from_starts: before.starts_at, to_starts: after.starts_at, from_closer: before.closer_id, to_closer: after.closer_id,
  });
  try {
    await moveEvent(before, after);
  } catch (e) {
    return { erro: `O horário mudou no painel, mas a agenda do Google não foi atualizada (${(e as Error).message}). Avise o gestor.` };
  }
  redirect(`/reunioes?mudou=${id}`);
}
