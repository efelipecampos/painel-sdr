// Leitura dos dados da tela. Tudo vem das funções do banco (RPC) com a sessão do usuário.
import { createClient } from "@/lib/supabase/server";
import type { Period } from "@/lib/time";

export interface SdrMetrics {
  sdr_id: string;
  name: string;
  leads_abordados: number;
  templates_enviados: number;
  leads_responderam: number;
  primeira_resposta_s: number | null;
  leads_primeira_resposta: number;
  resposta_s: number | null;
  leads_resposta: number;
  aguardando: number;
  parados: number;
  descartados: number;
}

export interface TeamMetrics {
  sdrs: number;
  leads_abordados: number;
  templates_enviados: number;
  leads_responderam: number;
  primeira_resposta_s: number | null;
  leads_primeira_resposta: number;
  resposta_s: number | null;
  leads_resposta: number;
  aguardando: number;
  parados: number;
  descartados: number;
  dsq: number;
  disparo_mediana_s: number | null;
  cadastros: number;
  cadastros_sem_disparo: number;
}

export interface ChatRow {
  chat_id: string;
  poli_contact_uuid: string;
  lead_name: string | null;
  phone_masked: string | null;
  situacao: "aguardando" | "respondido" | "lead_nao_respondeu" | "encerrado_sem_resposta" | "fora_do_funil";
  waiting_since: string | null;
  parado: boolean;
  templates: number;
  primeira_resposta_s: number | null;
  resposta_s: number | null;
  msgs_lead: number;
  msgs_equipe: number;
  last_message_at: string | null;
  last_message_from: string | null;
  origem: "lead" | "poli" | null;
  fora_motivo: string | null;
  total: number;
}

export interface Settings {
  stale_minutes: number;
  stale_business_only: boolean;
  metrics_business_only: boolean;
  holidays_off: boolean;
}

function fail(what: string, error: { message: string }): never {
  throw new Error(`${what}: ${error.message}`);
}

export async function getSettings(): Promise<Settings> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema("painel").from("settings").select("key, value");
  if (error) fail("Não foi possível ler as configurações", error);
  const v = new Map((data ?? []).map((r) => [r.key, r.value]));
  return {
    stale_minutes: Number(v.get("stale_minutes") ?? 30),
    stale_business_only: Boolean(v.get("stale_business_only") ?? false),
    metrics_business_only: v.get("metrics_business_only") !== false,
    holidays_off: v.get("holidays_off") !== false,
  };
}

export async function getTeamMetrics(p: Period): Promise<TeamMetrics> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema("painel").rpc("team_metrics", { p_from: p.from.toISOString(), p_to: p.to.toISOString() });
  if (error) fail("Não foi possível calcular as métricas do time", error);
  return (data as TeamMetrics[])[0];
}

export async function getSdrMetrics(p: Period): Promise<SdrMetrics[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema("painel").rpc("sdr_metrics", { p_from: p.from.toISOString(), p_to: p.to.toISOString() });
  if (error) fail("Não foi possível calcular as métricas dos SDRs", error);
  return data as SdrMetrics[];
}

export async function getSdrChats(
  sdrId: string, p: Period, opts: { filter: string; search: string | null; limit: number; offset: number },
): Promise<ChatRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema("painel").rpc("sdr_chats", {
    p_sdr: sdrId, p_from: p.from.toISOString(), p_to: p.to.toISOString(),
    p_filter: opts.filter, p_search: opts.search, p_limit: opts.limit, p_offset: opts.offset,
  });
  if (error) fail("Não foi possível carregar os chats", error);
  return data as ChatRow[];
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}
