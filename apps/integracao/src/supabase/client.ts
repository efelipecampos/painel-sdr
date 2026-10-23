import { env } from "../config/env.js";

/**
 * Acesso ao Supabase pela API REST (PostgREST) com a service role key — sem
 * SDK, do mesmo jeito que falamos com o HubSpot. A service role ignora RLS,
 * então este serviço é o único que escreve; o painel lê com chave própria.
 */

export class SupabaseApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`Supabase API error ${status}: ${body.slice(0, 300)}`);
  }
}

export function isSupabaseConfigured(): boolean {
  return env.SUPABASE_URL !== "" && env.SUPABASE_SERVICE_ROLE_KEY !== "";
}

export async function supabaseFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1${path}`, {
    ...init,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });

  if (!res.ok) throw new SupabaseApiError(res.status, await res.text().catch(() => ""));
  if (res.status === 204) return undefined as T;

  const body = await res.text();
  return (body ? JSON.parse(body) : undefined) as T;
}
