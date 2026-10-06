#!/usr/bin/env bash
# Deploy do painel: monta as imagens AQUI (linux/amd64) e só troca os containers na VPS.
# Nada é compilado na VPS (incidente de 06/10/2026: o build travou a máquina). Requer o Docker Desktop aberto.
# Uso: npm run deploy
set -euo pipefail
cd "$(dirname "$0")/.."

VPS="root@76.13.112.74"
KEY="$HOME/.ssh/id_ed25519_hostinger_api4com"
SSH=(ssh -i "$KEY" -o ConnectTimeout=30 "$VPS")
var() { grep -E "^$1=" .env | cut -d= -f2- | sed 's/[[:space:]]*#.*$//'; }

docker info >/dev/null 2>&1 || { echo "Abra o Docker Desktop e rode de novo." >&2; exit 1; }

echo "1/4 Montando as imagens (linux/amd64)..."
docker buildx build --platform linux/amd64 --target worker -t painel-sdr-worker:latest --load .
docker buildx build --platform linux/amd64 --target web -t painel-sdr-web:latest --load \
  --build-arg NEXT_PUBLIC_SUPABASE_URL="$(var NEXT_PUBLIC_SUPABASE_URL)" \
  --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY="$(var NEXT_PUBLIC_SUPABASE_ANON_KEY)" .

echo "2/4 Copiando arquivos de configuração (sem o .env, que já está na VPS)..."
rsync -az -e "ssh -i $KEY" --exclude node_modules --exclude .git --exclude .next --exclude .env --exclude .claude --exclude coverage \
  ./ "$VPS:/root/painel-sdr/"

echo "3/4 Enviando as imagens para a VPS..."
docker save painel-sdr-worker:latest painel-sdr-web:latest | gzip -1 | "${SSH[@]}" 'gunzip | docker load'

echo "4/4 Trocando os containers..."
"${SSH[@]}" 'cd /root/painel-sdr && docker compose up -d --no-build && docker image prune -f >/dev/null && docker ps --format "{{.Names}} | {{.Status}}" | grep -E "painel|poli-hubspot"'

sleep 5
curl -s -o /dev/null -m 20 -w "painel: %{http_code}\n" https://painel-sdr.camposai.com.br/login
curl -s -o /dev/null -m 20 -w "integração: %{http_code} (404 na raiz é normal)\n" https://poli-hubspot.camposai.com.br/
