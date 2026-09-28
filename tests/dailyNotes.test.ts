import { describe, expect, it } from "vitest";
import { brasiliaDay, buildNoteBody, dayRange } from "../src/jobs/dailyNotes.js";
import type { DayMessage } from "../src/supabase/messages.js";

const message = (overrides: Partial<DayMessage>): DayMessage => ({
  sent_at: "2026-09-27T12:00:00.000Z",
  direction: "IN",
  text: "Oi",
  media_description: null,
  template_name: null,
  attendant_name: null,
  lead_name: "Ivanete",
  hubspot_contact_id: "123",
  ...overrides,
});

describe("dayRange", () => {
  it("fecha o dia no horário de Brasília, não em UTC", () => {
    const { fromIso, toIso } = dayRange("2026-09-27");

    expect(fromIso).toBe("2026-09-27T03:00:00.000Z");
    expect(toIso).toBe("2026-09-28T03:00:00.000Z");
  });
});

describe("brasiliaDay", () => {
  it("usa o dia anterior em Brasília na virada em UTC", () => {
    // 28/09 02:00 UTC ainda é 27/09 às 23:00 em Brasília.
    const nowMs = Date.parse("2026-09-28T02:00:00Z");

    expect(brasiliaDay(nowMs)).toBe("2026-09-27");
    expect(brasiliaDay(nowMs, 1)).toBe("2026-09-26");
  });
});

describe("buildNoteBody", () => {
  it("lista as mensagens do dia com hora local, autor e template", () => {
    const body = buildNoteBody("2026-09-27", [
      message({ sent_at: "2026-09-27T12:00:00.000Z", direction: "OUT", text: "Olá!", attendant_name: "Gabriela", template_name: "aberturadomilhão" }),
      message({ sent_at: "2026-09-27T13:30:00.000Z", direction: "IN", text: "Quero saber mais" }),
    ]);

    expect(body).toContain("27/09/2026");
    expect(body).toContain("09:00 — <b>Gabriela (time) [template: aberturadomilhão]</b>: Olá!");
    expect(body).toContain("10:30 — <b>Ivanete (lead)</b>: Quero saber mais");
    expect(body).toContain("2 mensagem(ns)");
  });

  it("descreve mídia e escapa HTML do conteúdo", () => {
    const body = buildNoteBody("2026-09-27", [
      message({ media_description: "[Áudio] (https://cdn.poli/a.ogg)", text: null }),
      message({ text: "<script>alert(1)</script>" }),
    ]);

    expect(body).toContain("[Áudio] (https://cdn.poli/a.ogg)");
    expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(body).not.toContain("<script>");
  });

  it("marca quando a conversa foi cortada por tamanho", () => {
    const longa = Array.from({ length: 4000 }, () => message({ text: "mensagem bem comprida ".repeat(5) }));

    const body = buildNoteBody("2026-09-27", longa);

    expect(body.length).toBeLessThan(65_536);
    expect(body).toContain("cortada nesta nota");
  });
});
