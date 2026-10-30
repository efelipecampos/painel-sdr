import { createClient } from "@/lib/supabase/server";
import type { Aderencia, Comportamento, Numeros } from "@/lib/sdr-modelo";

export interface Versao { versao: number; created_at: string; comportamentos: Comportamento[] }

/** Aderência e números do período, e a versão do SDR Ideal usada (a em uso no fim do período). */
export async function carregar(from: Date, to: Date) {
  const db = (await createClient()).schema("painel");
  const args = { p_from: from.toISOString(), p_to: to.toISOString() };
  const [ad, nu] = await Promise.all([db.rpc("sdr_modelo_aderencia", args), db.rpc("sdr_modelo_numeros", args)]);
  if (ad.error) throw new Error(`Não foi possível ler a aderência: ${ad.error.message}`);
  if (nu.error) throw new Error(`Não foi possível ler os números: ${nu.error.message}`);
  const linhas = (ad.data ?? []) as Aderencia[];
  const numeros = (nu.data ?? []) as (Numeros & Record<string, unknown>)[];
  let versao: Versao | null = null;
  if (linhas.length) {
    const v = await db.from("sdr_ideal_versoes").select("versao, created_at, comportamentos").eq("versao", linhas[0].versao).single();
    if (v.error) throw new Error(`Não foi possível ler o SDR Ideal: ${v.error.message}`);
    versao = v.data as Versao;
  }
  return { linhas, numeros, versao };
}

/** Os comportamentos ativos da versão, na ordem dela (os de conversa só quando tiverem valor: 9c). */
export function comportamentosAtivos(versao: Versao | null, linhas: Aderencia[]): Comportamento[] {
  const comLinha = new Set(linhas.map((l) => l.comportamento));
  return (versao?.comportamentos ?? []).filter((c) => c.ativo && comLinha.has(c.id));
}
