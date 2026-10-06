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
ssh -i $K root@76.13.112.74 'cd /root/painel-sdr && docker compose up -d --build'
```

Se uma migration mudou o cálculo das métricas, recalcule depois do deploy:
`ssh -i $K root@76.13.112.74 'docker exec painel-sdr-worker npx tsx apps/worker/src/index.ts --rebuild-all'`

## Conferir

```bash
ssh -i $K root@76.13.112.74 'docker ps | grep painel; docker logs --tail 5 painel-sdr-worker'
curl -s -o /dev/null -w "%{http_code}\n" https://painel-sdr.camposai.com.br/login   # 200
```

O build pesa na VPS (CPU alta por alguns minutos). Prefira fora do horário de pico.
