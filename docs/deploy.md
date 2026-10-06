# Deploy do Painel SDR (VPS Hostinger com Coolify)

- VPS: `76.13.112.74`, pasta `/root/painel-sdr`. Chave SSH: `~/.ssh/id_ed25519_hostinger_api4com`.
- Domínio: `painel-sdr.camposai.com.br` (registro A na Hostinger → 76.13.112.74). HTTPS pelo Traefik do Coolify.
- Containers: `painel-sdr-web` (Next.js, sem porta publicada) e `painel-sdr-worker` (lê raw_events a cada 30 s e o HubSpot a cada 15 min).
- O `.env` da VPS tem só: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `POLI_SDR_EMAILS`, `POLI_CLOSER_EMAILS`, `POLI_MANAGER_EMAILS`, `POLI_BOT_EMAILS`, `HUBSPOT_PRIVATE_APP_TOKEN` (permissão 600). Nada de senha do banco nem token do CLI.

## Atualizar

Sempre depois do merge na `main` e com as migrations já aplicadas (`npm run db:push`).

```bash
K=~/.ssh/id_ed25519_hostinger_api4com
rsync -az -e "ssh -i $K" --exclude node_modules --exclude .git --exclude .next --exclude .env --exclude .claude --exclude coverage \
  ./ root@76.13.112.74:/root/painel-sdr/
ssh -i $K root@76.13.112.74 'cd /root/painel-sdr && docker compose build painel-worker && docker compose build painel-web && docker compose up -d'
```

Se uma migration mudou o cálculo das métricas, recalcule depois do deploy:
`ssh -i $K root@76.13.112.74 'docker exec painel-sdr-worker npx tsx apps/worker/src/index.ts --rebuild-all'`

## Conferir

```bash
ssh -i $K root@76.13.112.74 'docker ps | grep painel; docker logs --tail 5 painel-sdr-worker'
curl -s -o /dev/null -w "%{http_code}\n" https://painel-sdr.camposai.com.br/login   # 200
```

## Regras de segurança (incidente de 06/10/2026)

Em 06/10, às 14:41, o build do Next.js esgotou a memória da VPS (8 GB, 2 CPUs, sem swap, compartilhada com
Langfuse/ClickHouse, Chatwoot, n8n, Coolify e a integração). A máquina travou ~25 min, inclusive a integração
Poli → HubSpot (eventos perdidos) e foi preciso reiniciar pelo hPanel. Desde então:

1. **Deploy só fora do horário comercial** (depois das 18h ou antes das 8h), com aviso ao Felipe.
2. A VPS tem **4 GB de swap** (`/swapfile`, `vm.swappiness=10`) como rede de segurança.
3. O build do Next.js roda com `NODE_OPTIONS=--max-old-space-size=1536` (Dockerfile).
4. Monte uma imagem por vez: `docker compose build painel-worker && docker compose build painel-web && docker compose up -d`.
5. Durante o build, acompanhe a integração: `curl -s -o /dev/null -w "%{http_code}" https://poli-hubspot.camposai.com.br/` deve
   seguir respondendo (404 na raiz é normal). Se parar de responder, cancele o build (`pkill -f "docker compose"`).
6. Montar a imagem fora da VPS foi descartado pelo Felipe (o computador dele nem sempre está ligado).
