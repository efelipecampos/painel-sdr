import { createClient } from "@/lib/supabase/server";
import type { Aderencia, Comportamento, Numeros } from "@/lib/sdr-modelo";

export interface Versao { versao: number; created_at: string; comportamentos: Comportamento[] }

/**
 * Aderência do período (uma chamada: o banco guarda os números por dia) e a versão do SDR Ideal usada (a em uso no fim
 * do período). O resumo de cada SDR (abordados, responderam, reuniões) vem nas próprias linhas da aderência.
 */
export async function carregar(from: Date, to: Date) {
  const db = (await createClient()).schema("painel");
  const ad = await db.rpc("sdr_modelo_aderencia", { p_from: from.toISOString(), p_to: to.toISOString() });
  if (ad.error) throw new Error(`Não foi possível ler a aderência: ${ad.error.message}`);
  const linhas = (ad.data ?? []) as (Aderencia & Numeros & { dias_faltando: number })[];
  const numeros: Numeros[] = [...new Map(linhas.map((l) => [l.sdr_id, {
    sdr_id: l.sdr_id, name: l.name, leads_abordados: l.leads_abordados, leads_responderam: l.leads_responderam, reunioes: l.reunioes,
  }])).values()];
  const diasFaltando = linhas[0]?.dias_faltando ?? 0;
  let versao: Versao | null = null;
  if (linhas.length) {
    const v = await db.from("sdr_ideal_versoes").select("versao, created_at, comportamentos").eq("versao", linhas[0].versao).single();
    if (v.error) throw new Error(`Não foi possível ler o SDR Ideal: ${v.error.message}`);
    versao = v.data as Versao;
  }
  return { linhas, numeros, versao, diasFaltando };
}

/** Os comportamentos ativos da versão, na ordem dela (os de conversa só quando tiverem valor: 9c). */
export function comportamentosAtivos(versao: Versao | null, linhas: Aderencia[]): Comportamento[] {
  const comLinha = new Set(linhas.map((l) => l.comportamento));
  return (versao?.comportamentos ?? []).filter((c) => c.ativo && comLinha.has(c.id));
}
