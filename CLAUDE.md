# Painel SDR — Poli Digital

Painel interno que mostra, por SDR, os indicadores de atendimento no Poli Chat, a lista de chats de cada SDR, o status de reuniões e um score de qualidade de lead feito pelo Claude.

Dono do projeto: Felipe (Head of Revenue). Usuários da V1: Felipe e, depois, os gestores da Poli.

## Leia antes de qualquer tarefa

- `docs/COMECE-AQUI.md`: como conduzir o projeto com o Felipe, estado atual, pontos de parada, checklist de revisão e decisões. Comece por ele e mantenha o "Estado atual" e as "Decisões" atualizados.
- `docs/spec.md`: arquitetura, schema, definição exata de cada métrica, integrações e deploy. É a fonte da verdade.
- `docs/roteiro.md`: as fases do projeto, na ordem. Trabalhe uma fase por vez.
- `design/`: telas de referência (`Main.dc.html`, `SDR.dc.html`, `Configuracoes.dc.html`) e os tokens visuais (`tokens.json`). A interface deve reproduzir essas telas.

## Stack

- Banco, Auth e RLS: Supabase (projeto gerenciado, região São Paulo).
- App web: Next.js (App Router) + TypeScript.
- Worker (processamento de eventos, sync HubSpot, score): Node + TypeScript, processo separado.
- IA do score: API da Anthropic (SDK oficial). Modelo em variável de ambiente.
- Deploy: VPS Hostinger que já roda **Coolify**. O Traefik do Coolify cuida de domínio e HTTPS. Não instale Caddy, Nginx nem nada que use as portas 80/443. Siga o padrão do projeto `PoliChat-Hubspot`: Docker Compose com labels do Traefik na rede `coolify`.
- Migrations: Supabase CLI (`supabase/migrations`). Nunca altere o banco de produção à mão.

## Relação com a integração PoliChat-Hubspot

- Este projeto NÃO recebe o webhook da Poli. Quem recebe é o serviço `PoliChat-Hubspot` (repositório separado, já em produção na mesma VPS), que grava cada evento cru em `public.raw_events` no Supabase.
- O banco é um só (Supabase `pabbgxaphooftdsdewmq`) e as migrations de TODO o banco ficam neste repositório, inclusive as tabelas que a integração usa (`public.messages` e `public.raw_events`).
- A integração ESCREVE em `public.messages` e `public.raw_events`; o painel só LÊ essas duas. O formato delas é um contrato com o código da integração: nunca mude coluna, tipo ou nome delas sem mudar a integração junto.
- As tabelas do painel ficam no schema `painel`.
- Qualquer mudança necessária na integração é feita no repositório dela, não aqui.

## Regras

- Português do Brasil em toda a interface, mensagens de erro e comentários voltados ao usuário.
- Fuso de negócio: `America/Sao_Paulo`. Guarde tudo como `timestamptz` (UTC) e converta só na borda.
- A chave `service_role` do Supabase fica SOMENTE no servidor (API routes e worker). O navegador usa a chave anon + sessão do usuário + RLS.
- Todo evento externo (Poli, HubSpot) é gravado cru em `raw_events` ANTES de qualquer processamento. O processamento é idempotente e pode ser refeito a partir de `raw_events`.
- Métricas são calculadas no banco (funções SQL/RPC), não no front. O front só exibe.
- Regra de negócio nova ou ambígua: pare e pergunte ao Felipe. Não invente definição de métrica.
- Segredos só em `.env` (fora do git). Mantenha `.env.example` atualizado.
- Toda lógica de cálculo de tempo (horário comercial, pareamento de mensagens) tem teste automatizado.
- Dados de leads são dados pessoais (LGPD): nada de log com conteúdo de mensagem ou telefone completo.
