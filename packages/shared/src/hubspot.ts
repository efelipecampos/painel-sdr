// Consulta ao vivo do HubSpot na hora de agendar (Fase 10d): contato e Lead associado, por id ou link.
// Só leitura. Usado no servidor do painel (o token não vai ao navegador).

const API = "https://api.hubapi.com";
export const USERS_PROP = "sdr_2_0__quantidade_de_usuarios_a_utilizar_a_plataforma";
const CONTACT_PROPS = ["firstname", "lastname", "email", "phone", "mobilephone", "company", "website", "hubspot_owner_id", USERS_PROP];
const LEAD_PROPS = ["hs_lead_name", "hs_pipeline", "hs_pipeline_stage", "hubspot_owner_id", "hs_createdate", USERS_PROP];

export type HubspotRef = { kind: "contact" | "lead" | "id"; id: string };

/** Link de Contato (0-1) ou de Lead (0-136) do HubSpot, ou um id puro. */
export function parseHubspotRef(input: string): HubspotRef | null {
  const s = input.trim();
  if (/^\d{3,20}$/.test(s)) return { kind: "id", id: s };
  const rec = /\/record\/(0-1|0-136)\/(\d+)/.exec(s);
  if (rec) return { kind: rec[1] === "0-1" ? "contact" : "lead", id: rec[2] };
  const contact = /\/contacts\/\d+\/contact\/(\d+)/.exec(s);
  if (contact) return { kind: "contact", id: contact[1] };
  return null;
}

export interface LeadInfo {
  contactId: string;
  leadId: string | null;
  name: string | null;
  company: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  ownerId: string | null;   // dono do Lead (ou do contato, se não houver Lead)
  stageId: string | null;
  pipelineId: string | null;
  users: number | null;     // número de usuários (Lead primeiro, depois contato)
}

type Fetch = typeof fetch;
type Obj = { id: string; properties: Record<string, string | null> };

export class HubspotLive {
  constructor(private readonly token: string, private readonly f: Fetch = fetch) {}

  private async call<T>(path: string, body?: unknown): Promise<T | null> {
    const r = await this.f(API + path, {
      method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`HubSpot: HTTP ${r.status}`);
    return (await r.json()) as T;
  }

  private contact(id: string) {
    return this.call<Obj>(`/crm/v3/objects/contacts/${id}?properties=${CONTACT_PROPS.join(",")}`);
  }

  private async assoc(from: "contacts" | "leads", id: string, to: "leads" | "contacts"): Promise<string[]> {
    const j = await this.call<{ results: { toObjectId: number | string }[] }>(`/crm/v4/objects/${from}/${id}/associations/${to}`);
    return (j?.results ?? []).map((x) => String(x.toObjectId));
  }

  private async leads(ids: string[]): Promise<Obj[]> {
    if (!ids.length) return [];
    const j = await this.call<{ results: Obj[] }>("/crm/v3/objects/leads/batch/read", { inputs: ids.map((id) => ({ id })), properties: LEAD_PROPS });
    return j?.results ?? [];
  }

  /**
   * Contato e Lead a partir de um link ou id. Id puro: tenta como contato e, se não existir, como Lead.
   * Lead escolhido: o informado; senão, o mais recente do pipeline preferido; senão, o mais recente.
   */
  async lookup(ref: HubspotRef, preferredPipeline: string | null = null): Promise<LeadInfo | null> {
    let contact: Obj | null = null;
    let lead: Obj | null = null;
    if (ref.kind === "contact" || ref.kind === "id") contact = await this.contact(ref.id);
    if (!contact && (ref.kind === "lead" || ref.kind === "id")) {
      [lead] = await this.leads([ref.id]);
      if (!lead) return null;
      const [cid] = await this.assoc("leads", lead.id, "contacts");
      contact = cid ? await this.contact(cid) : null;
    }
    if (!contact) return null;
    if (!lead) {
      const all = await this.leads(await this.assoc("contacts", contact.id, "leads"));
      const recent = (xs: Obj[]) => [...xs].sort((a, b) => String(b.properties.hs_createdate ?? "").localeCompare(String(a.properties.hs_createdate ?? "")))[0];
      lead = recent(all.filter((l) => preferredPipeline && l.properties.hs_pipeline === preferredPipeline)) ?? recent(all) ?? null;
    }
    const c = contact.properties;
    const l = lead?.properties ?? {};
    const num = (v: string | null | undefined) => (v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
    const name = [c.firstname, c.lastname].filter(Boolean).join(" ").trim() || l.hs_lead_name || null;
    return {
      contactId: contact.id,
      leadId: lead?.id ?? null,
      name,
      company: c.company || null,
      email: c.email?.toLowerCase() || null,
      phone: c.phone || c.mobilephone || null,
      website: c.website || null,
      ownerId: l.hubspot_owner_id || c.hubspot_owner_id || null,
      stageId: l.hs_pipeline_stage || null,
      pipelineId: l.hs_pipeline || null,
      users: num(l[USERS_PROP]) ?? num(c[USERS_PROP]),
    };
  }
}

/** Carrossel sugerido pelo número de usuários, na marca escolhida. Null = sem sugestão. */
export function suggestCarousel<T extends { brand: string; suggest_min_users: number | null; suggest_max_users: number | null }>(
  users: number | null, brand: string, carousels: T[],
): T | null {
  if (users == null) return null;
  return carousels.find((c) => c.brand === brand && (c.suggest_min_users != null || c.suggest_max_users != null)
    && (c.suggest_min_users == null || users >= c.suggest_min_users)
    && (c.suggest_max_users == null || users <= c.suggest_max_users)) ?? null;
}
