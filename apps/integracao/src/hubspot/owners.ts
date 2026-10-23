import { hubspotFetch } from "./client.js";

interface OwnersPage {
  results: Array<{ id: string; email?: string }>;
  paging?: { next?: { after: string } };
}

let emailToOwnerId: Map<string, string> | null = null;

async function loadOwners(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let after: string | undefined;

  do {
    const query = after ? `?after=${after}&limit=100` : "?limit=100";
    const page = await hubspotFetch<OwnersPage>(`/crm/v3/owners${query}`);
    for (const owner of page.results) {
      if (owner.email) map.set(owner.email.toLowerCase(), owner.id);
    }
    after = page.paging?.next?.after;
  } while (after);

  return map;
}

/** Busca o Owner do HubSpot pelo e-mail, cacheando a lista de owners em memória. */
export async function getOwnerIdByEmail(email: string): Promise<string | undefined> {
  if (!emailToOwnerId) {
    emailToOwnerId = await loadOwners();
  }
  return emailToOwnerId.get(email.toLowerCase());
}

export function invalidateOwnersCache(): void {
  emailToOwnerId = null;
}
