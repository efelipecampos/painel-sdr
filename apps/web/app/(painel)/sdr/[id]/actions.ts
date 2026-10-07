"use server";

// Grava o status de reunião com a sessão do usuário. A função do banco confere se é admin ou gestor ativo.
import { revalidatePath } from "next/cache";
import { createClient, getMe, isManager } from "@/lib/supabase/server";

export async function setMeetingStatus(leadId: string, status: string | null): Promise<{ error: string | null }> {
  // Checagem antecipada (a função do banco confere de novo): só admin e gestor marcam reunião.
  if (!isManager(await getMe())) return { error: "Sem permissão para alterar." };
  const supabase = await createClient();
  const { error } = await supabase.schema("painel").rpc("set_meeting_status", { p_lead: leadId, p_status: status });
  if (error) return { error: error.message.includes("acesso negado") ? "Sem permissão para alterar." : "Não foi possível salvar. Tente de novo." };
  revalidatePath("/sdr/[id]", "page");
  revalidatePath("/");
  return { error: null };
}
