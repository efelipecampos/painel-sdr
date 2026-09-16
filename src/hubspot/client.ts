import { env } from "../config/env.js";

const BASE_URL = "https://api.hubapi.com";

export class HubSpotApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(`HubSpot API error ${status}: ${JSON.stringify(body)}`);
  }
}

export async function hubspotFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.HUBSPOT_PRIVATE_APP_TOKEN}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => undefined);
    throw new HubSpotApiError(res.status, body);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
