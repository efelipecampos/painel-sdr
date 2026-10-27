// Descarte automático do Lead no HubSpot quando o lead clica num botão de corte (Fase 11, decisão do Felipe, 2026-10-16).
// Lead mais recente do contato no pipeline do SDR → Descartado, com [SDR] Motivo de Perda, Observação de desqualificação
// e "D. Auto. Botões | " no começo do nome. Não mexe em Lead já descartado, DSQ, em Garantir Agendamento ou Qualificado.
import { nomeDescartado } from "@painel/shared/jornada";
import type { HubspotClient } from "../hubspot/leads.js";

const PIPELINE = "841793591";
const DESCARTADO = "1250901141";
const NAO_MEXER = new Set([DESCARTADO, "1250901142", "1250901139", "1358962969"]); // Descartado, DSQ - BR, Garantir, Qualificado

type Lead = { id: string; properties: Record<string, string | null> };

/** Devolve o resultado para o registro do envio: descartado, já fora do funil, sem Lead no HubSpot ou erro. */
export async function descartarNoHubspot(
  hs: Pick<HubspotClient, "call">, contactId: string | null, motivo: string, obs: string, opcoes: { prefixo?: boolean } = {},
): Promise<string> {
  if (!contactId) return "sem Lead no HubSpot";
  try {
    const a = await hs.call<{ results?: { toObjectId: string | number }[] }>(`/crm/v4/objects/contacts/${contactId}/associations/leads`);
    const ids = (a.results ?? []).map((r) => String(r.toObjectId));
    if (!ids.length) return "sem Lead no HubSpot";
    const r = await hs.call<{ results: Lead[] }>("/crm/v3/objects/leads/batch/read", {
      inputs: ids.slice(0, 100).map((id) => ({ id })),
      properties: ["hs_pipeline", "hs_pipeline_stage", "hs_lead_name", "hs_createdate"],
    });
    const lead = r.results.filter((l) => l.properties.hs_pipeline === PIPELINE)
      .sort((x, y) => String(y.properties.hs_createdate ?? "").localeCompare(String(x.properties.hs_createdate ?? "")))[0];
    if (!lead) return "sem Lead no HubSpot";
    if (NAO_MEXER.has(String(lead.properties.hs_pipeline_stage))) return "já fora do funil";
    await hs.call(`/crm/v3/objects/leads/${lead.id}`, {
      properties: {
        hs_pipeline_stage: DESCARTADO,
        sdr__motivo_de_perda: motivo,
        hs_lead_disqualification_note: obs,
        // descarte por tag da Poli: sem prefixo no nome (decisão do Felipe, 2026-10-27)
        ...(opcoes.prefixo === false ? {} : { hs_lead_name: nomeDescartado(lead.properties.hs_lead_name) }),
      },
    }, "PATCH");
    return "descartado";
  } catch (e) {
    return `erro: ${String(e instanceof Error ? e.message : e).replace(/\d{8,}/g, "#").slice(0, 120)}`;
  }
}
