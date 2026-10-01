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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Limite por segundo do HubSpot: espera e tenta de novo em vez de falhar. */
const RATE_LIMIT_RETRIES = 4;

export async function hubspotFetch<T>(path: string, init: RequestInit = {}, attempt = 1): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.HUBSPOT_PRIVATE_APP_TOKEN}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });

  if (res.status === 429 && attempt <= RATE_LIMIT_RETRIES) {
    const retryAfter = Number(res.headers.get("retry-after"));
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * attempt);
    return hubspotFetch<T>(path, init, attempt + 1);
  }

  if (!res.ok) {
    const body = await res.json().catch(() => undefined);
    throw new HubSpotApiError(res.status, body);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
