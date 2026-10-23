import { beforeEach, describe, expect, it, vi } from "vitest";
import sent from "./fixtures/sent.json" with { type: "json" };

/**
 * Gestor em POLI_HUBSPOT_ONLY_EMAILS: a mensagem vira Communication no
 * HubSpot, mas sem papel — não conta como SDR/Closer e não gera alerta.
 */

process.env.POLI_HUBSPOT_ONLY_EMAILS = "Gestor@Poli.Digital";
// Como na VPS: os campos do Contato/Negócio são do Painel de SDR.
process.env.HUBSPOT_FIELDS_ENABLED = "false";

vi.mock("../src/hubspot/contacts.js", () => ({ findContact: vi.fn() }));
vi.mock("../src/hubspot/communications.js", () => ({ createCommunication: vi.fn(async () => "comm-1") }));
vi.mock("../src/hubspot/deals.js", () => ({
  getOpenDealsForContact: vi.fn(async () => []),
  writeCycleToDeals: vi.fn(),
  fillMissingDealChatLinks: vi.fn(async () => []),
}));
vi.mock("../src/hubspot/owners.js", () => ({ getOwnerIdByEmail: vi.fn(async () => "owner-1") }));
vi.mock("../src/alerts/googleChat.js", () => ({ sendLeadNotInHubSpotAlert: vi.fn() }));
vi.mock("../src/supabase/client.js", () => ({ isSupabaseConfigured: () => false, supabaseFetch: vi.fn() }));

const { getAttendantRole, isHubspotOnlyAttendant } = await import("../src/config/team.js");
const { processMessage } = await import("../src/pipeline/processMessage.js");
const { parseMessageEvent } = await import("../src/poli/parser.js");
const { poliWebhookBodySchema } = await import("../src/poli/types.js");
const { findContact } = await import("../src/hubspot/contacts.js");
const { createCommunication } = await import("../src/hubspot/communications.js");
const { sendLeadNotInHubSpotAlert } = await import("../src/alerts/googleChat.js");

function messageFrom(email: string) {
  return { ...parseMessageEvent(poliWebhookBodySchema.parse(sent)), attendantEmail: email };
}

describe("POLI_HUBSPOT_ONLY_EMAILS", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("não dá papel de pré-venda (fica fora das métricas do painel)", () => {
    expect(isHubspotOnlyAttendant("gestor@poli.digital")).toBe(true);
    expect(getAttendantRole("gestor@poli.digital")).toBeNull();
    expect(isHubspotOnlyAttendant("suporte@poli.digital")).toBe(false);
  });

  it("registra a mensagem no HubSpot quando o contato existe", async () => {
    vi.mocked(findContact).mockResolvedValue({ contactId: "123", matchedVia: "phone" } as never);
    const result = await processMessage(messageFrom("gestor@poli.digital"));
    expect(result).toMatchObject({ outcome: "logged", contactId: "123" });
    expect(createCommunication).toHaveBeenCalledTimes(1);
  });

  it("contato não encontrado: não registra e não alerta", async () => {
    vi.mocked(findContact).mockResolvedValue(null as never);
    const result = await processMessage(messageFrom("gestor@poli.digital"));
    expect(result).toEqual({ outcome: "skipped_contact_not_found" });
    expect(sendLeadNotInHubSpotAlert).not.toHaveBeenCalled();
    expect(createCommunication).not.toHaveBeenCalled();
  });

  it("quem não está em lista nenhuma continua ignorado", async () => {
    const result = await processMessage(messageFrom("suporte@poli.digital"));
    expect(result).toEqual({ outcome: "skipped_not_presales" });
    expect(findContact).not.toHaveBeenCalled();
  });
});
