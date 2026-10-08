"use server";

// Ações da lista do SDR, com a sessão do usuário. As funções do banco conferem se é admin, gestor ou SDR ativo.
import { revalidatePath } from "next/cache";
import { createClient, getMe, isManager } from "@/lib/supabase/server";

export async function setMeetingStatus(leadId: string, status: string | null): Promise<{ error: string | null }> {
  // Checagem antecipada (a função do banco confere de novo): admin, gestor e SDR marcam reunião (2026-10-08).
  const me = await getMe();
  if (!isManager(me) && me?.role !== "sdr") return { error: "Sem permissão para alterar." };
  const supabase = await createClient();
  const { error } = await supabase.schema("painel").rpc("set_meeting_status", { p_lead: leadId, p_status: status });
  if (error) return { error: error.message.includes("acesso negado") ? "Sem permissão para alterar." : "Não foi possível salvar. Tente de novo." };
  revalidatePath("/sdr/[id]", "page");
  revalidatePath("/");
  return { error: null };
}

/** Finaliza o lead à mão (tira de "Aguardando", como a nota "0" na Poli) ou desfaz. */
export async function finalizarLead(leadId: string, finalizar: boolean): Promise<{ error: string | null }> {
  const me = await getMe();
  if (!isManager(me) && me?.role !== "sdr") return { error: "Sem permissão para alterar." };
  const supabase = await createClient();
  const { error } = await supabase.schema("painel").rpc("finalizar_lead", { p_lead: leadId, p_finalizar: finalizar });
  if (error) return { error: error.message.includes("acesso negado") ? "Sem permissão para alterar." : "Não foi possível salvar. Tente de novo." };
  revalidatePath("/sdr/[id]", "page");
  revalidatePath("/");
  return { error: null };
}
