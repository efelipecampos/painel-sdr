import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { NextConfig } from "next";

// Em desenvolvimento, lê do .env da raiz só as variáveis públicas (URL e chave anon do Supabase).
// Em produção elas vêm do docker compose (lá o servidor também recebe a service_role e as chaves do Google,
// usadas só em rotas e server actions; ver docker-compose.yml).
const rootEnv = resolve(__dirname, "../../.env");
if (existsSync(rootEnv)) {
  for (const line of readFileSync(rootEnv, "utf8").split("\n")) {
    const m = /^(NEXT_PUBLIC_[A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].split("#")[0].trim();
  }
}

// CSP (Fase 8): o navegador só fala com o próprio painel. Supabase, Google e HubSpot são chamados pelo servidor;
// a fonte (next/font) é servida pelo painel. 'unsafe-inline' em script porque o Next injeta scripts inline sem nonce;
// 'unsafe-eval' só em desenvolvimento (recarga do Next). Links para HubSpot e Poli são navegação e não passam pela CSP.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "production" ? "" : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: resolve(__dirname, "../.."),
  transpilePackages: ["@painel/shared"],
  poweredByHeader: false,
  // Volta para uma tela já vista em até 30 s sem ir ao servidor (os dados se atualizam a cada 60 s).
  experimental: { staleTimes: { dynamic: 30 } },
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "X-Frame-Options", value: "DENY" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
        { key: "Content-Security-Policy", value: csp },
      ],
    }];
  },
};

export default nextConfig;
