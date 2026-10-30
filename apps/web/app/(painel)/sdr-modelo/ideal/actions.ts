"use server";

import { revalidatePath } from "next/cache";
import { createClient, getMe, isManager } from "@/lib/supabase/server";
import type { Comportamento } from "@/lib/sdr-modelo";

/** Salva o SDR Ideal como versão nova (o banco valida tudo e recusa se outra pessoa salvou no meio). */
export async function salvarSdrIdeal(base: number, comportamentos: Comportamento[], mudancas: string[]): Promise<{ erro?: string; versao?: number }> {
  if (!isManager(await getMe())) return { erro: "Só gestores e admin editam o SDR Ideal." };
  const { data, error } = await (await createClient()).schema("painel").rpc("salvar_sdr_ideal", {
    p_base_versao: base, p_comportamentos: comportamentos, p_mudancas: mudancas,
  });
  if (error) return { erro: error.message };
  revalidatePath("/sdr-modelo", "layout");
  return { versao: data as number };
}
