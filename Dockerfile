# Imagens do painel: "web" (Next.js) e "worker" (Node). Build: docker compose up -d --build
FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/shared/package.json packages/shared/
# O npm 11.19 (node:24-slim de out/2026) deixa de fora o binário nativo do TypeScript 7 (pacote opcional por
# plataforma) e o "next build" quebra no passo de TypeScript. Instala o da plataforma da imagem, na mesma versão.
RUN npm ci && npm install --no-save --no-audit --no-fund \
  "@typescript/typescript-$(node -p 'process.platform + "-" + process.arch')@$(node -p 'require("typescript/package.json").version')"

FROM deps AS web-build
COPY . .
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_TELEMETRY_DISABLED=1 \
    NODE_OPTIONS=--max-old-space-size=1536
# Limite de memória da compilação: a VPS é compartilhada com outros serviços (ver docs/deploy.md).
RUN npm run build -w @painel/web

FROM node:24-slim AS web
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
COPY --from=web-build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=web-build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]

FROM deps AS worker
COPY packages ./packages
COPY apps/worker ./apps/worker
ENV NODE_ENV=production
USER node
CMD ["npx", "tsx", "apps/worker/src/index.ts"]
