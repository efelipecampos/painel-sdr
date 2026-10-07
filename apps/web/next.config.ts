import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { NextConfig } from "next";

// Em desenvolvimento, lê do .env da raiz só as variáveis públicas (URL e chave anon do Supabase).
// Em produção elas vêm do docker compose. A service_role nunca é carregada no app web.
const rootEnv = resolve(__dirname, "../../.env");
if (existsSync(rootEnv)) {
  for (const line of readFileSync(rootEnv, "utf8").split("\n")) {
    const m = /^(NEXT_PUBLIC_[A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].split("#")[0].trim();
  }
}

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
      ],
    }];
  },
};

export default nextConfig;
