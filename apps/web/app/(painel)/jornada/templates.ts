// Templates do Poli para a busca de template (Regras e Acompanhamento): os usados nos últimos 30 dias primeiro.
// Texto completo só dos usados no mês e dos pedidos em `comTexto`; os outros carregam o texto quando escolhidos.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TemplateOpcao } from "./RegrasView";

export async function carregarTemplates(db: ReturnType<SupabaseClient["schema"]>, comTexto: Set<string> = new Set()): Promise<TemplateOpcao[]> {
  const templates: TemplateOpcao[] = [];
  for (let i = 0; ; i += 1000) {
    const { data } = await db.from("poli_templates").select("uuid, key, status, body, buttons").order("key").range(i, i + 999);
    for (const t of data ?? []) {
      templates.push({ uuid: t.uuid, key: t.key, status: t.status, body: t.body ?? "", trecho: (t.body ?? "").slice(0, 160),
        buttons: ((t.buttons as { text: string }[]) ?? []).map((b) => b.text), recente: false });
    }
    if (!data || data.length < 1000) break;
  }
  const { data: usados } = await db.rpc("templates_usados", { p_desde: new Date(Date.now() - 30 * 864e5).toISOString() });
  const usos = new Map(((usados ?? []) as { template_name: string; envios: number }[]).map((u) => [u.template_name, u.envios]));
  for (const t of templates) {
    t.recente = usos.has(t.key);
    if (!t.recente && !comTexto.has(t.uuid)) t.body = null;
  }
  return templates.sort((a, b) => (usos.get(b.key) ?? 0) - (usos.get(a.key) ?? 0) || a.key.localeCompare(b.key));
}

/** Hora (São Paulo) da última cópia da lista de templates do Poli, para o cabeçalho da Jornada. */
export async function templatesAtualizadosEm(db: ReturnType<SupabaseClient["schema"]>): Promise<string | null> {
  const { data } = await db.from("poli_templates").select("synced_at").order("synced_at", { ascending: false }).limit(1).maybeSingle();
  return data ? new Date(data.synced_at).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" }) : null;
}
