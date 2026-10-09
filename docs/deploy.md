# Deploy do Painel SDR (VPS Hostinger com Coolify)

- VPS: `76.13.112.74`, pasta `/root/painel-sdr`. Chave SSH: `~/.ssh/id_ed25519_hostinger_api4com`.
- Domínio: `painel-sdr.camposai.com.br` (registro A na Hostinger → 76.13.112.74). HTTPS pelo Traefik do Coolify.
- Containers: `painel-sdr-web` (Next.js, sem porta publicada) e `painel-sdr-worker` (lê raw_events a cada 30 s e o HubSpot a cada 15 min).
- O `.env` da VPS (permissão 600) tem só o que os containers usam: Supabase (URL, anon, service_role), e-mails por papel, HubSpot, Google (OAuth e cifra do token), alertas do Google Chat e a IA do score (`SCORE_IA`, Celeris). Lista completa em `.env.example`. Nada de senha do banco nem token do CLI.

## Atualizar

Checklist, nesta ordem:

1. **Avise o Felipe** e espere o ok: só uma publicação por vez (há mais de uma sessão no projeto).
2. **Branch em dia com a main:** `git fetch && git merge origin/main`, depois `npm test` e `npm run typecheck`.
3. **Migrations, se houver:** confira a última na `main` (o nome da nova precisa ser posterior),
   `npm run db:push -- --dry-run`, mostre o SQL ao Felipe e, com o ok, `npm run db:push`.
4. **Merge na `main`** e `git push`.
5. **Publique** com o Docker Desktop aberto:

```bash
npm run deploy
```

6. **Confira** (seção abaixo) e avise o Felipe com o commit publicado.

O script (`scripts/deploy.sh`) monta as duas imagens no Mac para linux/amd64, copia os arquivos (sem o `.env`), envia as
imagens prontas (`docker save | ssh docker load`) e troca os containers com `docker compose up -d --no-build`.
**Nada é compilado na VPS.** O computador só é usado no momento do deploy: depois, o painel roda 24 h na VPS.

Se uma migration mudou o cálculo das métricas, recalcule depois do deploy:
`ssh -i ~/.ssh/id_ed25519_hostinger_api4com root@76.13.112.74 'docker exec painel-sdr-worker npx tsx apps/worker/src/index.ts --rebuild-all'`

## Conferir

```bash
ssh -i $K root@76.13.112.74 'docker ps | grep painel; docker logs --tail 5 painel-sdr-worker'
curl -s -o /dev/null -w "%{http_code}\n" https://painel-sdr.camposai.com.br/login   # 200
```

## Alertas (Fase 8)

O worker avisa no espaço **Gestão SDR** do Google Chat (webhook em `GOOGLE_CHAT_WEBHOOK_URL_ALERTAS`). Cada problema
avisa uma vez quando começa (🔴) e uma vez quando resolve (✅). Sem a URL, os alertas só aparecem no log do worker.

| Alerta | Quando | Variável (padrão) |
|---|---|---|
| Fila parada | evento da Poli esperando há 10 min sem o worker processar | `ALERTA_FILA_MIN` (10) |
| Integração muda | 30 min, contados em horário comercial, sem evento novo da Poli | `ALERTA_POLI_MIN` (30) |
| Worker com erro | todas as rodadas falhando por 5 min | `ALERTA_WORKER_MIN` (5) |
| HubSpot | sync falhando por 30 min | `ALERTA_HUBSPOT_MIN` (30) |
| Painel fora do ar | `/login` sem resposta ou com erro 5xx por 5 min | `ALERTA_PAINEL_MIN` (5) |

As verificações rodam a cada 2 min (`ALERTA_INTERVALO_MIN`). Limite conhecido: se a VPS inteira cair, o worker cai junto
e ninguém avisa; nesse caso o sinal é o painel fora do ar para quem tentar abrir.

## Backup

Pelo Supabase (plano Pro): backup diário automático, guardado por 7 dias. Restaurar: painel do Supabase → Database →
Backups. Decisão do Felipe em 2026-10-07: sem cópia extra fora do Supabase por enquanto.

## Regras de segurança (incidente de 06/10/2026)

Em 06/10, às 14:41, o build do Next.js esgotou a memória da VPS (8 GB, 2 CPUs, sem swap, compartilhada com
Langfuse/ClickHouse, Chatwoot, n8n, Coolify e a integração). A máquina travou ~25 min, inclusive a integração
Poli → HubSpot (eventos perdidos) e foi preciso reiniciar pelo hPanel. Desde então:

1. **Deploy só fora do horário comercial** (depois das 18h ou antes das 8h), com aviso ao Felipe.
2. A VPS tem **4 GB de swap** (`/swapfile`, `vm.swappiness=10`) como rede de segurança.
3. **As imagens são montadas fora da VPS** (`npm run deploy`). Se um dia precisar montar na VPS, uma por vez e fora do horário comercial; o build do Next.js já tem `NODE_OPTIONS=--max-old-space-size=1536`.
4. Durante o build, acompanhe a integração: `curl -s -o /dev/null -w "%{http_code}" https://poli-hubspot.camposai.com.br/` deve
   seguir respondendo (404 na raiz é normal). Se parar de responder, cancele o build (`pkill -f "docker compose"`).


## Revisão de segurança (Fase 8, 09/10/2026)

Conferido em produção, só leitura:

- **RLS ligado nas 28 tabelas** de `painel` e `public`. `public.messages` e `public.raw_events` não têm nenhum GRANT para
  `anon` nem `authenticated`: o navegador não lê essas tabelas.
- **Policies:** leitura de configurações, feriados, horário e critérios para usuário ativo; escrita só admin; carrosséis
  só gestor; `profiles` só o próprio (admin vê todos).
- **Funções `security definer` liberadas para usuário logado:** 30; todas com `search_path` fixo. 29 conferem o papel
  por dentro (`is_active_user`, `is_manager`, `escopo_sdr`...). `carrossel_outra_marca` não confere, mas só devolve o id
  de um carrossel (sem dado de lead).
- **`anon`** (sem login) não tem acesso ao schema `painel` nem executa função do painel. `public.rls_auto_enable` é o
  gatilho do próprio Supabase que liga RLS em tabela nova (não pode ser chamado pela API).
- **Segredos:** `.env` fora do git e fora da imagem (`.dockerignore`); nenhuma chave no histórico do git; o navegador só
  recebe a chave anon.
- **Cabeçalhos HTTP:** `X-Frame-Options`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, HSTS, sem `X-Powered-By` e,
  desde esta revisão, `Content-Security-Policy` (o navegador só fala com o próprio painel; ver `apps/web/next.config.ts`).
- **Login:** limite de tentativas (5 por e-mail e 20 por IP em 15 min, `apps/web/lib/login-limit.ts`).
- **Rate limit do webhook da Poli:** fica no repositório PoliChat-Hubspot (pedido feito em 09/10).

Para repetir a conferência do banco: rodar as consultas de catálogo (`pg_class.relrowsecurity`, `pg_policies`,
`information_schema.role_table_grants` para `anon`/`authenticated`, e `has_function_privilege` nas funções com
`prosecdef`) com `supabase db query --db-url ...` (mesma conexão de `scripts/db-push.sh`).
