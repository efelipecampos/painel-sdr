import { hubspotFetch as rawHubspotFetch, HubSpotApiError } from "../src/hubspot/client.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A busca do HubSpot tem limite por segundo compartilhado com a integração em
// produção — espaça as chamadas e, se bater no limite, espera e tenta de novo.
export async function hubspotFetch<T>(path: string, init?: RequestInit): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    await sleep(400);
    try {
      return await rawHubspotFetch<T>(path, init);
    } catch (err) {
      if (!(err instanceof HubSpotApiError) || err.status !== 429 || attempt >= 8) throw err;
      await sleep(2000 * attempt);
    }
  }
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
