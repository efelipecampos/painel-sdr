// Alerta de desequilíbrio do carrossel (decisão do Felipe, 2026-10-28): closer que recebeu 3 ou mais reuniões a menos
// do que o esperado pelo peso dele no período do carrossel (o mês). Uma vez por dia útil, às 09:00, a partir do 10º
// dia útil do mês, numa mensagem só no Gestão SDR e só se houver alguém. Usa o saldo do livro-caixa
// (painel.carousel_saldos). LGPD: só nomes de closer e carrossel, nada de lead.
import type { SupabaseClient } from "@supabase/supabase-js";
import { BUSINESS_TIMEZONE } from "@painel/shared";

export const LIMITE_ABAIXO = 3;
export const DIA_UTIL_MINIMO = 10;
export const HORA_ALERTA = "09:00";

/** Dia de hoje (AAAA-MM-DD) e hora (HH:MM) no fuso de negócio. */
export function agoraNegocio(now: Date): { dia: string; hora: string } {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const g = (t: string) => p.find((x) => x.type === t)!.value;
  return { dia: `${g("year")}-${g("month")}-${g("day")}`, hora: `${g("hour")}:${g("minute")}` };
}

/** Qual dia útil do mês é `dia` (seg a sex, fora os feriados); 0 se o próprio dia não for útil. */
export function diaUtilDoMes(dia: string, feriados: Set<string>): number {
  const util = (d: string) => { const w = new Date(`${d}T12:00:00Z`).getUTCDay(); return w !== 0 && w !== 6 && !feriados.has(d); };
  if (!util(dia)) return 0;
  let n = 0;
  for (let d = `${dia.slice(0, 8)}01`; d <= dia; d = new Date(Date.parse(`${d}T12:00:00Z`) + 86400_000).toISOString().slice(0, 10)) if (util(d)) n++;
  return n;
}

export interface Saldo { carrossel: string; closer: string; recebidas: number; esperadas: number }

export function textoDesequilibrio(lista: Saldo[]): string | null {
  const abaixo = lista.filter((s) => s.esperadas - s.recebidas >= LIMITE_ABAIXO)
    .sort((a, b) => (b.esperadas - b.recebidas) - (a.esperadas - a.recebidas));
  if (!abaixo.length) return null;
  return `⚖️ *Carrossel desequilibrado* (mês até agora; ${LIMITE_ABAIXO} ou mais reuniões abaixo do esperado pelo peso)\n`
    + abaixo.map((s) => `• ${s.carrossel}: ${s.closer} recebeu ${s.recebidas}, esperado ${s.esperadas.toFixed(1)} (${(s.recebidas - s.esperadas).toFixed(1)})`).join("\n")
    + "\nVale conferir se a agenda dele está fechada com bloqueios.";
}

/** Devolve o texto do alerta quando é hora de mandar (e marca o dia), ou null. */
export async function alertaDesequilibrio(db: SupabaseClient, now = new Date()): Promise<string | null> {
  const p = db.schema("painel");
  const { dia, hora } = agoraNegocio(now);
  if (hora < HORA_ALERTA) return null;
  const { data: st } = await p.from("settings").select("value").eq("key", "alerta_desequilibrio_dia").maybeSingle();
  if (st?.value === dia) return null;
  const { data: fer } = await p.from("holidays").select("day").gte("day", `${dia.slice(0, 8)}01`).lte("day", dia);
  const feriados = new Set(((fer ?? []) as { day: string }[]).map((f) => f.day));
  const n = diaUtilDoMes(dia, feriados);
  await p.from("settings").upsert({ key: "alerta_desequilibrio_dia", value: dia, updated_at: new Date().toISOString() });
  if (n < DIA_UTIL_MINIMO) return null;

  const { data: cars } = await p.from("carousels").select("id, name, brand, balance_period").eq("active", true);
  const lista: Saldo[] = [];
  for (const c of (cars ?? []) as { id: string; name: string; brand: string; balance_period: string }[]) {
    const { data: pk } = await p.rpc("period_key", { p_at: now.toISOString(), p_period: c.balance_period });
    const { data: saldos, error } = await p.rpc("carousel_saldos", { p_carousel: c.id, p_period_key: pk });
    if (error) throw new Error(`carousel_saldos: ${error.message}`);
    const { data: membros } = await p.from("carousel_members").select("closer_id, active, weight, sdrs(name, active)").eq("carousel_id", c.id);
    const ativo = new Map(((membros ?? []) as unknown as { closer_id: string; active: boolean; weight: number; sdrs: { name: string; active: boolean } | null }[])
      .filter((m) => m.active && m.weight > 0 && m.sdrs?.active).map((m) => [m.closer_id, m.sdrs!.name]));
    for (const s of (saldos ?? []) as { closer_id: string; creditos: number; recebidas: number }[]) {
      const nome = ativo.get(s.closer_id);
      if (nome) lista.push({ carrossel: `${c.brand === "chatshub" ? "ChatsHub" : "Poli"} · ${c.name}`, closer: nome, recebidas: Number(s.recebidas), esperadas: Number(s.creditos) });
    }
  }
  return textoDesequilibrio(lista);
}
