// Uma reunião por lead (decisão de 2026-10-07, contra reunião duplicada no HubSpot). Se o lead já tem reunião
// do painel agendada, ou cancelada / no show dentro do prazo, não se cria outra: reagenda-se a mesma
// (mesmo evento do Google e mesma Reunião do HubSpot). Validada ou Invalidada: pode criar nova.
import { createAdminClient } from "@/lib/supabase/admin";
import { escolherReaproveitavel, inicioDoPrazo, type Janela, type Reaproveitavel } from "@/lib/reaproveitar-regra";

export type { Janela, Reaproveitavel };

export async function janelaAtual(): Promise<Janela> {
  const { data } = await createAdminClient().schema("painel").from("settings").select("value").eq("key", "reuse_window").maybeSingle();
  return data?.value === "30d" ? "30d" : "mes";
}

export async function reuniaoReaproveitavel(leadId: string | null, contactId: string | null): Promise<Reaproveitavel | null> {
  if (!leadId && !contactId) return null;
  const or = [leadId ? `lead_id.eq.${leadId}` : null, contactId ? `hubspot_contact_id.eq.${contactId}` : null].filter(Boolean).join(",");
  const { data } = await createAdminClient().schema("painel").from("meetings")
    .select("id, status, starts_at, sdr_id, created_by, closer:sdrs!meetings_closer_id_fkey(name), sdr:sdrs!meetings_sdr_id_fkey(name)")
    .eq("source", "painel").or(or);
  const rows = ((data ?? []) as unknown as (Omit<Reaproveitavel, "closer" | "sdr"> & { closer: { name: string } | null; sdr: { name: string } | null })[])
    .map((m) => ({ ...m, closer: m.closer?.name ?? null, sdr: m.sdr?.name ?? null }));
  return escolherReaproveitavel(rows, inicioDoPrazo(await janelaAtual()));
}
