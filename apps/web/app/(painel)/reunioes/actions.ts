"use server";

// Ações da tela Reuniões (Fase 10d.2): status (com arquivo no Google) e mudança de horário (mesmo evento).
// A permissão é conferida no banco (permissao_reuniao / definir_status_reuniao) com a sessão do usuário.
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { busyOf, freeAt, loadRules } from "@/lib/agendar";
import { postGestaoSdr } from "@/lib/chat";
import { APP_URL } from "@/lib/google";
import { loadMeeting, moveEvent, renameEvent, syncEventWithStatus } from "@/lib/reuniao-google";
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

// ---------- 10e.2: trocas de closer e de marca ----------

const BRAND_LABEL = { poli: "Poli", chatshub: "ChatsHub" } as const;

/** Closers livres no horário da reunião, sem o closer atual (Google + painel). */
async function outrosLivres(meetingId: string): Promise<{ livres: string[]; m: Awaited<ReturnType<typeof loadMeeting>> }> {
  const { m, carouselId } = await candidatos(meetingId);
  const { data: eleg } = await admin().rpc("closers_elegiveis", { p_carousel: carouselId });
  const outros = ((eleg ?? []) as { closer_id: string }[]).map((e) => e.closer_id).filter((c) => c !== m.closer_id);
  const { carousel } = await loadRules(carouselId);
  const start = new Date(m.starts_at);
  const end = new Date(m.ends_at);
  return { livres: freeAt(await busyOf(outros, start, end, meetingId), start, end, carousel.gap_minutes), m };
}

export async function pedirTroca(id: string, reason: string): Promise<{ erro?: string; ok?: boolean }> {
  if (!reason.trim()) return { erro: "Escreva a justificativa." };
  if ((await permissao(id)) !== "sdr") return { erro: "Só o SDR da reunião pede troca de closer." };
  const { livres } = await outrosLivres(id);
  if (!livres.length) return { erro: "Não há outro closer disponível neste horário. O pedido não foi enviado. Se precisar, mude o horário da reunião." };
  const { error } = await (await createClient()).schema("painel").rpc("pedir_troca_closer", { p_meeting: id, p_reason: reason.slice(0, 1000) });
  if (error) return { erro: error.message };
  const { data: d } = await (await createClient()).schema("painel").rpc("reuniao_detalhe", { p_id: id });
  const r = (d ?? [])[0] as { sdr: string | null; lead_name: string | null; company: string | null; starts_at: string; closer: string } | undefined;
  const when = r ? new Date(r.starts_at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
  await postGestaoSdr(`🔁 *Pedido de troca de closer*\nSDR: ${r?.sdr ?? "—"}\nLead: ${r?.lead_name ?? "—"}${r?.company ? ` (${r.company})` : ""}\nReunião: ${when}\nCloser atual: ${r?.closer ?? "—"}\nJustificativa: ${reason.trim().slice(0, 500)}\nDecidir: ${APP_URL}/reunioes`);
  revalidatePath("/reunioes");
  return { ok: true };
}

/** Lista para o gestor escolher o novo closer (nomes só para gestor/admin). */
export async function closersLivres(id: string): Promise<{ id: string; name: string }[]> {
  if ((await permissao(id)) !== "gestor") return [];
  const { livres } = await outrosLivres(id);
  if (!livres.length) return [];
  const { data } = await admin().from("sdrs").select("id, name").in("id", livres).order("name");
  return (data ?? []) as { id: string; name: string }[];
}

/** Troca de closer por gestor/admin (direta ou aprovando pedido). closerId null = o carrossel decide. */
async function aplicarTroca(id: string, closerId: string | null, motivo: string): Promise<{ erro?: string; novo?: string }> {
  const { livres, m: before } = await outrosLivres(id);
  if (!livres.length) return { erro: "Não sobrou nenhum outro closer livre neste horário. Recuse o pedido ou mude o horário." };
  let novo: string;
  if (closerId) {
    if (!livres.includes(closerId)) return { erro: "Esse closer não está mais livre neste horário." };
    const r = await admin().rpc("trocar_closer", { p_meeting: id, p_novo_closer: closerId, p_livres: livres, p_motivo: motivo });
    if (r.error) return { erro: r.error.message };
    novo = closerId;
  } else {
    const r = await admin().rpc("trocar_closer_carrossel", { p_meeting: id, p_livres: livres, p_motivo: motivo });
    if (r.error) return { erro: r.error.message };
    novo = r.data as string;
  }
  const me = (await (await createClient()).auth.getUser()).data.user?.id ?? null;
  const after = (await loadMeeting(id))!;
  await admin().from("meetings").update({ hubspot_sync_needed: true }).eq("id", id);
  await admin().from("meeting_changes").insert({ meeting_id: id, changed_by: me, from_starts: before!.starts_at, to_starts: after.starts_at, from_closer: before!.closer_id, to_closer: novo });
  try {
    await moveEvent(before!, after);
  } catch (e) {
    return { erro: `Closer trocado no painel, mas a agenda do Google não foi atualizada (${(e as Error).message}).`, novo };
  }
  return { novo };
}

export async function trocarCloser(id: string, closerId: string | null, motivo: string): Promise<{ erro?: string }> {
  if ((await permissao(id)) !== "gestor") return { erro: "Só gestor e admin trocam o closer." };
  if (!motivo.trim()) return { erro: "Escreva o motivo da troca." };
  const r = await aplicarTroca(id, closerId, motivo.trim());
  revalidatePath("/reunioes");
  return { erro: r.erro };
}

export async function decidirPedido(requestId: string, decisao: "aprovar" | "recusar", closerId: string | null, nota: string): Promise<{ erro?: string }> {
  const { data: req } = await admin().from("closer_swap_requests").select("id, meeting_id, status, reason").eq("id", requestId).maybeSingle();
  if (!req || req.status !== "pendente") return { erro: "Este pedido não está mais pendente." };
  if ((await permissao(req.meeting_id)) !== "gestor") return { erro: "Só gestor e admin decidem pedidos de troca." };
  const me = (await (await createClient()).auth.getUser()).data.user?.id ?? null;
  if (decisao === "recusar") {
    await admin().from("closer_swap_requests").update({ status: "recusado", decided_by: me, decided_at: new Date().toISOString(), decision_note: nota.trim() || null }).eq("id", requestId);
    revalidatePath("/reunioes");
    return {};
  }
  const r = await aplicarTroca(req.meeting_id, closerId, `Pedido do SDR: ${req.reason}`);
  if (r.novo) {
    await admin().from("closer_swap_requests").update({
      status: "aprovado", decided_by: me, decided_at: new Date().toISOString(), decision_note: nota.trim() || null, to_closer: r.novo,
    }).eq("id", requestId);
  }
  revalidatePath("/reunioes");
  return { erro: r.erro };
}

/** "Passar para CH" / "Passar para Poli": carrossel de mesmo porte na outra marca; título no painel e no Google na hora. */
export async function passarMarca(id: string): Promise<{ erro?: string }> {
  const p = await permissao(id);
  if (p !== "closer" && p !== "gestor") return { erro: "Só o closer da reunião e os gestores mudam a marca." };
  const { data: m } = await admin().from("meetings").select("carousel_id, company, lead_name, title").eq("id", id).single();
  const { data: alvo } = await admin().rpc("carrossel_outra_marca", { p_carousel: m!.carousel_id });
  if (!alvo) return { erro: "Este carrossel não tem equivalente na outra marca." };
  const { data: car } = await admin().from("carousels").select("brand").eq("id", alvo).single();
  const r = await admin().rpc("trocar_carrossel", { p_meeting: id, p_novo_carrossel: alvo });
  if (r.error) return { erro: r.error.message };
  const title = `Apresentação ${BRAND_LABEL[car!.brand as "poli" | "chatshub"]} - ${m!.company || m!.lead_name || "Lead"}`;
  // hubspot_status_synced = null: a rodada das 17:55 envia o título novo (decisão de 2026-10-07)
  await admin().from("meetings").update({ title, hubspot_status_synced: null }).eq("id", id);
  revalidatePath("/reunioes");
  try {
    const after = await loadMeeting(id);
    if (after) await renameEvent(after);
  } catch (e) {
    return { erro: `Marca trocada no painel, mas o título no Google não foi atualizado (${(e as Error).message}).` };
  }
  return {};
}
