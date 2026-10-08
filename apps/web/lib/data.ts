// Leitura dos dados da tela. Tudo vem das funções do banco (RPC) com a sessão do usuário.
import { createClient } from "@/lib/supabase/server";
import type { MeetingStatus } from "@painel/shared";
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
  agendados: number;
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
  agendados: number;
}

export interface ChatRow {
  lead_id: string;
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
  reuniao_status: MeetingStatus | null;
  reuniao_origem: "hubspot" | "manual" | null;
  total: number;
}

/** Carteira do SDR (estado atual). sdr_id null = linha do time (só gestor e admin). */
export interface Carteira {
  sdr_id: string | null;
  carteira: number;
  avaliados: number;
  sem_avaliacao: number;
  qualidade: number | null;
}

export type NotaStatus = "avaliado" | "sem_informacao" | "ja_e_cliente" | "abaixo_do_corte";

/** Avaliação mais recente de um lead. */
export interface LeadNota {
  lead_id: string;
  status: NotaStatus;
  score: number | null;
  summary: string | null;
  criteria_scores: { criterio: string | null; peso: number | null; nota: string | null; justificativa: string }[];
  scored_at: string;
}

export interface Settings {
  stale_minutes: number;
  stale_business_only: boolean;
  metrics_business_only: boolean;
  holidays_off: boolean;
  google_archive_calendar_id: string;
  google_invite_sdr: boolean;
  reuse_window: "mes" | "30d";
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
    google_archive_calendar_id: String(v.get("google_archive_calendar_id") ?? ""),
    google_invite_sdr: v.get("google_invite_sdr") !== false,
    reuse_window: v.get("reuse_window") === "30d" ? "30d" : "mes",
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

export async function getCarteira(): Promise<Carteira[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema("painel").rpc("carteira");
  if (error) fail("Não foi possível calcular a carteira", error);
  return data as Carteira[];
}

export async function getLeadNotas(leadIds: string[]): Promise<Map<string, LeadNota>> {
  if (!leadIds.length) return new Map();
  const supabase = await createClient();
  const { data, error } = await supabase.schema("painel").rpc("lead_notas", { p_leads: leadIds });
  if (error) fail("Não foi possível carregar as notas dos leads", error);
  return new Map((data as LeadNota[]).map((n) => [n.lead_id, n]));
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}
