import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { descartarNoHubspot } from "./descarte.js";
import { observacaoTag, processarTagsDescarte } from "./tagDescarte.js";

/** HubSpot falso: um contato com um Lead aberto no pipeline do SDR; guarda o PATCH. */
function fakeHs(etapa = "1250901135", nota: string | null = null) {
  const patches: Record<string, string>[] = [];
  return {
    patches,
    hs: {
      call: async (path: string, body?: unknown) => {
        if (path.includes("/associations/leads")) return { results: [{ toObjectId: 77 }] } as never;
        if (path.endsWith("batch/read")) return { results: [{ id: "77", properties: { hs_pipeline: "841793591", hs_pipeline_stage: etapa, hs_lead_name: "Fulano", hs_createdate: "2026-10-20", hs_lead_disqualification_note: nota } }] } as never;
        patches.push((body as { properties: Record<string, string> }).properties);
        return {} as never;
      },
    },
  };
}

/** Banco falso, só o que processarTagsDescarte usa. */
function fakeDb(eventos: unknown[]) {
  const settings: Record<string, unknown> = { tag_descarte_cursor: 10, poli_tags_descarte: { "t-cnpj": "Sem CNPJ" } };
  const registros: Record<string, unknown>[] = [];
  const q = (data: unknown) => {
    const o: Record<string, unknown> = {};
    for (const m of ["select", "eq", "gt", "lte", "in", "not", "order", "limit"]) o[m] = () => o;
    o.then = (r: (v: unknown) => void) => r({ data, error: null });
    return o;
  };
  const painel = {
    from: (t: string) => ({
      select: () => {
        if (t === "settings") return q(Object.entries(settings).map(([key, value]) => ({ key, value })));
        if (t === "leads") return q([{ id: "l-1", hubspot_contact_id: "555" }]);
        return q([{ sdr_id: "s-1", sdrs: { name: "Jéssica" } }]);
      },
      upsert: async (row: Record<string, unknown>) => {
        if (t === "settings") settings[row.key as string] = row.value; else registros.push(row);
        return { error: null };
      },
    }),
  };
  let leituras = 0;
  const db = {
    schema: () => painel,
    from: () => ({ select: () => q(leituras++ === 0 ? [{ id: 20 }] : eventos) }),
  } as unknown as SupabaseClient;
  return { db, settings, registros };
}

const evento = (id: number, tag: string, nome: string) => ({
  id, received_at: "2026-10-27T18:00:00Z",
  payload: { value: { contact: { uuid: "c-1" }, tag: { uuid: tag, attributes: { name: nome } }, timestamp: "2026-10-27T17:02:00Z" } },
});

describe("descarte por tag da Poli", () => {
  it("observação começa com o texto fixo e traz tag, SDR e hora de Brasília", () => {
    expect(observacaoTag("Descarte - Sem CNPJ", "Jéssica", new Date("2026-10-27T17:02:00Z")))
      .toBe("Descartado via integração com Tag Poli. Tag: Descarte - Sem CNPJ. SDR do atendimento: Jéssica. Em 27/10/2026 14:02.");
    expect(observacaoTag("Descarte - Engano", null, new Date("2026-10-27T17:02:00Z"))).not.toMatch(/SDR/);
  });

  it("sem prefixo: não mexe no nome do Lead; a Jornada continua com prefixo", async () => {
    const a = fakeHs();
    expect(await descartarNoHubspot(a.hs, "555", "Sem CNPJ", "obs", { prefixo: false })).toBe("descartado");
    expect(a.patches[0]).toEqual({ hs_pipeline_stage: "1250901141", sdr__motivo_de_perda: "Sem CNPJ", hs_lead_disqualification_note: "obs" });
    const b = fakeHs();
    await descartarNoHubspot(b.hs, "555", "Sem CNPJ", "obs");
    expect(b.patches[0].hs_lead_name).toBeDefined();
  });

  it("descarta com o motivo da tag, registra e anda o cursor; tag sem motivo só registra", async () => {
    const { db, settings, registros } = fakeDb([evento(11, "t-cnpj", "Descarte - Sem CNPJ"), evento(12, "t-nova", "Descarte - Nova")]);
    const { hs, patches } = fakeHs();
    expect(await processarTagsDescarte(db, hs)).toBe(1);
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({ sdr__motivo_de_perda: "Sem CNPJ" });
    expect(patches[0].hs_lead_disqualification_note).toMatch(/^Descartado via integração com Tag Poli\. Tag: Descarte - Sem CNPJ\. SDR do atendimento: Jéssica\./);
    expect(registros.map((r) => r.resultado)).toEqual(["descartado", "tag sem motivo configurado"]);
    expect(settings.tag_descarte_cursor).toBe(20);
  });

  it("Lead já Descartado: troca o motivo e acrescenta a observação abaixo da anterior", async () => {
    const { db, registros } = fakeDb([evento(11, "t-cnpj", "Descarte - Sem CNPJ")]);
    const { hs, patches } = fakeHs("1250901141", "Descartado à mão: valor");
    expect(await processarTagsDescarte(db, hs)).toBe(1);
    expect(patches[0].sdr__motivo_de_perda).toBe("Sem CNPJ");
    expect(patches[0].hs_lead_disqualification_note).toMatch(/^Descartado à mão: valor\nDescartado via integração com Tag Poli\. Tag: Descarte - Sem CNPJ\./);
    expect(patches[0].hs_pipeline_stage).toBeUndefined();
    expect(registros[0].resultado).toBe("motivo atualizado");
  });

  it("Jornada continua sem mexer em Lead já Descartado", async () => {
    const { hs, patches } = fakeHs("1250901141");
    expect(await descartarNoHubspot(hs, "555", "Sem CNPJ", "obs")).toBe("já fora do funil");
    expect(patches).toHaveLength(0);
  });

  it("Lead em Garantir Agendamento não é mexido", async () => {
    const { db, registros } = fakeDb([evento(11, "t-cnpj", "Descarte - Sem CNPJ")]);
    const { hs, patches } = fakeHs("1250901139");
    expect(await processarTagsDescarte(db, hs)).toBe(0);
    expect(patches).toHaveLength(0);
    expect(registros[0].resultado).toBe("já fora do funil");
  });
});
