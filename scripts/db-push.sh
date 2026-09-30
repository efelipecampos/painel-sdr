#!/usr/bin/env bash
# Aplica as migrations de supabase/migrations no Supabase de produção.
# Uso: npm run db:push -- --dry-run   (simula e lista o que vai entrar)
#      npm run db:push                (aplica; só depois da aprovação do Felipe)
# Conecta pelo pooler (modo sessão) com SUPABASE_DB_PASSWORD do .env. Não precisa de token.
# A senha nunca aparece na saída.
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT_REF="pabbgxaphooftdsdewmq"
POOLER_HOST="aws-0-sa-east-1.pooler.supabase.com"

PW="$(grep -E '^SUPABASE_DB_PASSWORD=' .env | cut -d= -f2-)"
if [ -z "$PW" ]; then
  echo "SUPABASE_DB_PASSWORD está vazio no .env." >&2
  exit 1
fi
ENC="$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' "$PW")"

supabase db push "$@" --db-url "postgresql://postgres.${PROJECT_REF}:${ENC}@${POOLER_HOST}:5432/postgres" 2>&1 \
  | sed "s/${ENC}/***/g"
