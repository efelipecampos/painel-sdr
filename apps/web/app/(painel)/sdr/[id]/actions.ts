"use server";

// Grava o status de reunião com a sessão do usuário. A função do banco confere se é admin ou gestor ativo.
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export async function setMeetingStatus(leadId: string, status: string | null): Promise<{ error: string | null }> {
  const supabase = await createClient();
  const { error } = await supabase.schema("painel").rpc("set_meeting_status", { p_lead: leadId, p_status: status });
  if (error) return { error: error.message.includes("acesso negado") ? "Sem permissão para alterar." : "Não foi possível salvar. Tente de novo." };
  revalidatePath("/sdr/[id]", "page");
  revalidatePath("/");
  return { error: null };
}
