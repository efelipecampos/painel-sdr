# Painel SDR — Poli Digital

Painel interno com os indicadores de atendimento de cada SDR no Poli Chat, a lista de chats, o agendamento de
reuniões nos carrosséis dos closers e a nota de qualidade dos leads. Endereço: https://painel-sdr.camposai.com.br

Antes de qualquer tarefa, leia `CLAUDE.md` e `docs/COMECE-AQUI.md`. A especificação está em `docs/spec.md`.

## Estrutura

- `apps/web`: painel (Next.js, App Router).
- `apps/worker`: processa os eventos da Poli, sincroniza o HubSpot, dá a nota dos leads e manda os alertas.
- `packages/shared`: código usado pelos dois (cálculo de tempo, Google Agenda).
- `supabase/migrations`: todas as migrations do banco (inclusive as tabelas que a integração PoliChat-Hubspot usa).
- `scripts/`: `deploy.sh` (publicação) e `db-push.sh` (migrations em produção).

## Rodar localmente

```bash
npm install
cp .env.example .env        # preencha pelo TextEdit; nunca cole chave no chat
npm test                    # testes (vitest, banco em memória com PGlite)
npm run typecheck
npm run dev -w @painel/web  # painel em http://localhost:3000
```

## Publicar uma atualização

Passo a passo completo em `docs/deploy.md`. Regras que não mudam:

1. **Uma publicação por vez.** Há mais de uma sessão trabalhando no projeto: avise o Felipe antes e espere o ok
   de que ninguém mais está publicando.
2. **Só de branch em dia com a `main`.** `git fetch && git merge origin/main`, testes passando, depois merge na `main`.
3. **Migrations com aprovação.** `npm run db:push -- --dry-run`, mostre o SQL ao Felipe e só então `npm run db:push`.
   O nome da migration nova precisa ser posterior ao da última da `main`.
4. **Nunca monte imagem na VPS.** `npm run deploy` monta tudo no Mac (Docker Desktop aberto), envia as imagens prontas
   e só troca os containers. Montar na VPS já derrubou a máquina (incidente de 06/10/2026).
5. **Confira depois:** `/login` respondendo 200 e o log do worker sem erro.
