"use server";

// Ações do agendamento (Fase 10d). Todas conferem o papel (SDR, gestor, admin) e só devolvem ao navegador
// contagens de closers, nunca nome ou id, até a confirmação.
import { redirect } from "next/navigation";
import { GoogleError } from "@painel/shared/google";
import { HubspotLive, parseHubspotRef, suggestCarousel, type LeadInfo } from "@painel/shared/hubspot";
import { APP_URL, calendarOf, logCalendar } from "@/lib/google";
import { busyOf, candidates, countByStart, freeAt, loadRules } from "@/lib/agendar";
import { checkManual, gridSlots, interval, windowDays } from "@/lib/slots";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient, getMe, isManager, type Me } from "@/lib/supabase/server";

const SDR_PIPELINE = "841793591"; // [New] Pipeline SDR
const BRAND_LABEL = { poli: "Poli", chatshub: "ChatsHub" } as const;

async function who(): Promise<Me> {
  const me = await getMe();
  if (!me || !(me.role === "sdr" || isManager(me))) throw new Error("Acesso negado.");
  return me;
}

function hubspot(): HubspotLive {
  const t = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
  if (!t) throw new Error("HubSpot não configurado no servidor.");
  return new HubspotLive(t);
}

export interface LeadResult { lead_id: string; name: string | null; company: string | null; phone_final: string | null; hubspot_contact_id: string | null }

export async function buscarLeads(q: string): Promise<LeadResult[]> {
  await who();
  const { data, error } = await (await createClient()).schema("painel").rpc("buscar_leads_para_agendar", { p_q: q });
  if (error) throw new Error(error.message);
  return (data ?? []) as LeadResult[];
}

export interface LeadLoaded {
  erro?: string;
  leadId?: string | null;
  info?: LeadInfo & { ownerName: string | null; stageLabel: string | null };
  sugestao?: { poli: string | null; chatshub: string | null };
  reunioes?: { id: string; starts_at: string; status: string; carousel: string | null; closer: string | null; sdr: string | null }[];
}

/** Carrega o lead do HubSpot na hora: pelo lead do painel (contato já ligado) ou por link/id. */
export async function carregarLead(input: { leadId?: string; ref?: string }): Promise<LeadLoaded> {
  const me = await who();
  const db = admin();
  let leadId: string | null = null;
  let contactId: string | null = null;
  if (input.leadId) {
    const { data: l } = await db.from("leads").select("id, hubspot_contact_id").eq("id", input.leadId).maybeSingle();
    if (!l) return { erro: "Lead não encontrado." };
    if (me.role === "sdr") {
      const { data: own } = await db.from("chats").select("id").eq("lead_id", l.id).eq("sdr_id", me.sdrId!).limit(1);
      if (!own?.length) return { erro: "Este lead não é seu." };
    }
    leadId = l.id;
    contactId = l.hubspot_contact_id;
    if (!contactId) return { erro: "Este lead ainda não está ligado a um contato do HubSpot. Cole o link do contato ou do Lead do HubSpot abaixo.", leadId };
  }
  const ref = contactId ? { kind: "contact" as const, id: contactId } : parseHubspotRef(input.ref ?? "");
  if (!ref) return { erro: "Cole o link de um Contato ou de um Lead do HubSpot, ou o ID." };
  let info: LeadInfo | null;
  try {
    info = await hubspot().lookup(ref, SDR_PIPELINE);
  } catch {
    return { erro: "Não foi possível consultar o HubSpot agora. Tente de novo em instantes." };
  }
  if (!info) return { erro: "Lead não encontrado no HubSpot. Ele precisa existir lá antes de agendar." };
  // Usou o link para um lead que tem chat sem contato ligado: grava a ligação para não pedir de novo.
  if (leadId && !contactId) await db.from("leads").update({ hubspot_contact_id: info.contactId }).eq("id", leadId);
  const [owner, stage, cars, reunioes] = await Promise.all([
    info.ownerId ? db.from("hubspot_owners").select("name").eq("owner_id", info.ownerId).maybeSingle() : Promise.resolve({ data: null }),
    info.stageId ? db.from("hubspot_stages").select("label").eq("stage_id", info.stageId).maybeSingle() : Promise.resolve({ data: null }),
    db.from("carousels").select("id, brand, suggest_min_users, suggest_max_users").eq("active", true),
    (await createClient()).schema("painel").rpc("reunioes_do_lead", { p_lead: leadId, p_hubspot_contact_id: info.contactId }),
  ]);
  const cs = (cars.data ?? []) as { id: string; brand: string; suggest_min_users: number | null; suggest_max_users: number | null }[];
  return {
    leadId,
    info: { ...info, ownerName: (owner.data as { name?: string } | null)?.name ?? null, stageLabel: (stage.data as { label?: string } | null)?.label ?? null },
    sugestao: { poli: suggestCarousel(info.users, "poli", cs)?.id ?? null, chatshub: suggestCarousel(info.users, "chatshub", cs)?.id ?? null },
    reunioes: (reunioes.data ?? []) as LeadLoaded["reunioes"],
  };
}

const admin = () => createAdminClient().schema("painel");

export interface Dias { dias: string[] }

export async function diasDoCarrossel(carouselId: string): Promise<string[]> {
  await who();
  const { rules } = await loadRules(carouselId);
  return windowDays(new Date(), rules);
}

/** Horários da grade de um dia com a quantidade de closers disponíveis (nunca quem). */
export async function horarios(p: { carouselId: string; leadId: string | null; contactId: string | null; day: string; duration: number }) {
  await who();
  const { carousel, rules } = await loadRules(p.carouselId);
  if (!windowDays(new Date(), rules).includes(p.day)) return [];
  const starts = gridSlots(p.day, p.duration, rules, new Date());
  return countByStart(p.carouselId, p.leadId, p.contactId, p.day, starts, p.duration, carousel.gap_minutes);
}

/** Confere um horário ajustado à mão: quantos closers estão livres e os avisos. */
export async function conferir(p: { carouselId: string; leadId: string | null; contactId: string | null; local: string; duration: number }) {
  await who();
  const { carousel, rules } = await loadRules(p.carouselId);
  const check = checkManual(p.local, p.duration, rules, new Date());
  if (check.erro) return { ...check, count: 0 };
  const { start, end } = interval(p.local, p.duration);
  const busy = await busyOf(await candidates(p.carouselId, p.leadId, p.contactId), start, end);
  return { ...check, count: freeAt(busy, start, end, carousel.gap_minutes).length };
}

export interface ConfirmState { erro?: string }

/** Confirma: confere tudo de novo no servidor, distribui, cria o evento e só então mostra o closer. */
export async function confirmar(_: ConfirmState, form: FormData): Promise<ConfirmState> {
  const me = await who();
  const s = (k: string) => String(form.get(k) ?? "").trim();
  const carouselId = s("carouselId");
  const local = s("local");
  const duration = Number(s("duration"));
  const email = s("email").toLowerCase();
  const handoff = s("handoff");
  if (!carouselId || !local) return { erro: "Escolha o carrossel e o horário." };
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { erro: "O e-mail do lead parece inválido. Corrija ou deixe em branco." };
  if (handoff.length > 4000) return { erro: "A passagem de bastão está longa demais (máximo 4.000 caracteres)." };

  // SDR responsável: o próprio SDR; gestor/admin escolhe na tela.
  const sdrId = me.role === "sdr" ? me.sdrId! : (s("sdrId") || null);
  const loaded = await carregarLead(s("leadId") ? { leadId: s("leadId") } : { ref: s("contactId") });
  if (loaded.erro || !loaded.info) return { erro: loaded.erro ?? "Lead não encontrado no HubSpot." };
  const info = loaded.info;

  let ctx: Awaited<ReturnType<typeof loadRules>>;
  try {
    ctx = await loadRules(carouselId);
  } catch (e) {
    return { erro: (e as Error).message };
  }
  const check = checkManual(local, duration, ctx.rules, new Date());
  if (check.erro) return { erro: check.erro };
  const { start, end } = interval(local, duration);

  const db = admin();
  const leadId = loaded.leadId ?? (await db.rpc("lead_para_agendar", { p_hubspot_contact_id: info.contactId, p_name: info.name, p_company: info.company })).data as string;
  const livres = freeAt(await busyOf(await candidates(carouselId, leadId, info.contactId), start, end), start, end, ctx.carousel.gap_minutes);
  if (!livres.length) return { erro: "Nenhum closer está livre neste horário agora. Escolha outro horário." };

  const r = await db.rpc("reservar_reuniao", {
    p_carousel: carouselId, p_lead: leadId, p_starts: start.toISOString(), p_ends: end.toISOString(),
    p_livres: livres, p_sdr: sdrId, p_created_by: me.id,
  });
  if (r.error) {
    if (r.error.hint === "sem_closer_livre") return { erro: "Nenhum closer está livre neste horário agora. Escolha outro horário." };
    if (r.error.hint === "closer_do_lead_ocupado") return { erro: "O closer que já atende este lead não está livre neste horário. Escolha outro horário." };
    return { erro: `Não foi possível agendar: ${r.error.message}` };
  }
  const { meeting_id: meetingId, closer_id: closerId } = (r.data as { meeting_id: string; closer_id: string }[])[0];

  const [{ data: sdr }, { data: conn }] = await Promise.all([
    sdrId ? db.from("sdrs").select("poli_email").eq("id", sdrId).single() : Promise.resolve({ data: null }),
    db.from("google_connections").select("google_email").eq("closer_id", closerId).single(),
  ]);
  // Título do evento: "Apresentação Poli - Empresa" (decisão do Felipe em 2026-10-07; sem o nome do closer).
  const title = `Apresentação ${BRAND_LABEL[ctx.carousel.brand]} - ${info.company || info.name || "Lead"}`;
  const attendees = [email, ctx.inviteSdr ? (sdr as { poli_email?: string } | null)?.poli_email : null].filter((x): x is string => !!x);

  try {
    const cal = await calendarOf(closerId);
    const ev = await cal.insert({
      title, start, end, attendees,
      description: `Reunião agendada pelo Painel SDR.\n\nPassagem de bastão (equipe Poli, precisa de login): ${APP_URL}/reuniao/${meetingId}`,
    });
    await logCalendar({ closer_id: closerId, meeting_id: meetingId, op: "criar", ok: true });
    const up = await db.from("meetings").update({
      lead_name: info.name, company: info.company, lead_email: email || null, hubspot_contact_id: info.contactId,
      hubspot_lead_id: info.leadId, title, handoff: handoff || null, fora_do_padrao: check.foraDoPadrao,
      google_calendar_id: conn?.google_email ?? "primary", google_event_id: ev.id, meet_url: ev.hangoutLink ?? null,
      google_state: "ok", google_checked_at: new Date().toISOString(),
    }).eq("id", meetingId);
    if (up.error) throw new Error(up.error.message);
  } catch (e) {
    const g = e instanceof GoogleError ? e : null;
    await logCalendar({ closer_id: closerId, meeting_id: null, op: "criar", ok: false, http_status: g?.status ?? null, reason: g?.reason ?? String((e as Error).message).slice(0, 200) });
    await db.rpc("desfazer_reserva", { p_meeting: meetingId });
    return { erro: "Não foi possível criar o evento na agenda do closer. Nada foi agendado. Tente de novo; se continuar, avise o gestor." };
  }
  redirect(`/agendar/sucesso/${meetingId}`);
}
