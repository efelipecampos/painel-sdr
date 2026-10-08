// Limite de tentativas de login (Fase 8). Todo login sai do servidor do painel para o Supabase com o mesmo IP,
// então o limite do Supabase valeria para todo mundo junto: um robô tentando senhas travaria o login de todos.
// Aqui o limite é por e-mail e por IP de quem acessa, na memória do servidor (um só container; zera ao reiniciar).
// Só tentativa errada conta; login certo limpa o e-mail.

export const LIMITS = {
  email: { max: 5, windowMs: 15 * 60_000 },
  ip: { max: 20, windowMs: 15 * 60_000 },
};

export class LoginLimiter {
  private fails = new Map<string, number[]>();

  constructor(private limits = LIMITS) {}

  private recent(key: string, windowMs: number, now: number): number[] {
    const list = (this.fails.get(key) ?? []).filter((t) => now - t < windowMs);
    if (list.length) this.fails.set(key, list);
    else this.fails.delete(key);
    return list;
  }

  /** Minutos até poder tentar de novo, ou 0 se pode tentar agora. */
  blockedFor(email: string, ip: string, now = Date.now()): number {
    let until = 0;
    for (const [key, l] of [[`e:${email.toLowerCase()}`, this.limits.email], [`i:${ip}`, this.limits.ip]] as const) {
      const list = this.recent(key, l.windowMs, now);
      if (list.length >= l.max) until = Math.max(until, list[list.length - l.max] + l.windowMs);
    }
    return until ? Math.max(1, Math.ceil((until - now) / 60_000)) : 0;
  }

  fail(email: string, ip: string, now = Date.now()): void {
    for (const key of [`e:${email.toLowerCase()}`, `i:${ip}`]) this.fails.set(key, [...(this.fails.get(key) ?? []), now]);
    if (this.fails.size > 10_000) this.fails.clear(); // proteção de memória contra enxurrada de e-mails diferentes
  }

  success(email: string): void {
    this.fails.delete(`e:${email.toLowerCase()}`);
  }
}

/** IP de quem acessa: o Traefik põe o IP real no começo do X-Forwarded-For. */
export function clientIp(forwardedFor: string | null, realIp: string | null): string {
  return forwardedFor?.split(",")[0]?.trim() || realIp?.trim() || "desconhecido";
}
