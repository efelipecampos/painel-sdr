# Mudança na integração PoliChat-Hubspot

Esta mudança é feita no repositório `PoliChat-Hubspot`, numa sessão do Claude Code aberta NAQUELA pasta. Não no repositório do painel.

## Objetivo

Gravar o corpo cru de cada evento que a Poli entrega em `public.raw_events` no Supabase, para o painel reconstruir chats, donos, status e tempos de resposta. Hoje a integração descarta justamente o que o painel precisa: eventos `SYSTEM` (transferências, abertura e encerramento), eventos que não são mensagem, e os campos `attendance.uuid`, `attendance.status` e `author.type`.

## Regras

- O fluxo atual (HubSpot, Google Chat, `public.messages`, nota diária) não muda em nada.
- A gravação em `raw_events` acontece logo depois da validação da assinatura e ANTES de qualquer filtro (tipo de evento, direção, whitelist de SDR/Closer, schema).
- Exceção: eventos de ACK de entrega/leitura e atualização de mensagem ficam fora (volume alto, inúteis para o painel). Grave `received`, `sent`, mensagens `SYSTEM` e todos os eventos que não são de mensagem.
- Falha ao gravar no Supabase nunca pode atrasar a resposta 200 para a Poli nem derrubar o fluxo do HubSpot. Grave depois de responder, e se falhar, guarde na fila SQLite local com retry (mesmo mecanismo que já existe).
- Idempotência: chave única `(source, external_id)`, com `external_id` = `uuid` do evento (raiz do corpo). Reentrega da Poli não duplica.

## Tabelas

As duas tabelas que a integração usa são criadas pela primeira migration do repositório do PAINEL (o banco tem um histórico de migrations só). Não rode nada disso à mão no SQL Editor.

```sql
-- 1) public.messages: copiar exatamente de PoliChat-Hubspot/supabase/schema.sql

-- 2) public.raw_events
create table if not exists public.raw_events (
  id bigint generated always as identity primary key,
  source text not null default 'poli_webhook',
  event_type text,              -- header x-webhook-event, ou object + event do corpo
  external_id text not null,    -- uuid do evento
  payload jsonb not null,
  received_at timestamptz not null default now(),
  unique (source, external_id)
);
create index if not exists raw_events_received_at_idx on public.raw_events (received_at);
alter table public.raw_events enable row level security;

-- 3) Privilégios: o projeto não expõe tabelas novas automaticamente.
grant select, insert, update on public.messages, public.raw_events to service_role;
grant usage, select on all sequences in schema public to service_role;
-- Nada para anon nem authenticated.
```

## Ligar o Supabase na integração (VPS)

A integração nunca gravou no Supabase: `SUPABASE_URL` está vazio. Para ligar, no `.env` da integração na VPS:

```
SUPABASE_URL=https://pabbgxaphooftdsdewmq.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service_role do projeto>
DAILY_NOTES_ENABLED=false
```

ATENÇÃO: com o Supabase configurado, a integração liga sozinha a **nota diária por contato no HubSpot** (`DAILY_NOTES_ENABLED` vem `true` por padrão). Deixe `false` até decidir se quer essas notas no HubSpot. Senão, a partir do dia seguinte, cada contato com conversa ganha uma nota nova no HubSpot.

Histórico: depois de ligar, o script `npm run backfill:supabase` da integração preenche `public.messages` com as mensagens antigas a partir das Communications do HubSpot. `raw_events` não tem histórico; ele começa no dia do deploy.

## Prompt para o Claude Code (na pasta PoliChat-Hubspot)

> Leia o README e o `src/server.ts`. Quero adicionar uma gravação do evento cru da Poli em `public.raw_events` no Supabase, seguindo exatamente o arquivo [cole aqui o conteúdo de integracao-mudancas.md do repositório do painel]. Antes de codar, me mostre onde no `server.ts` a gravação entra e como ela usa a fila SQLite em caso de falha. Escreva testes: evento `received` grava; evento `SYSTEM` grava; evento não-mensagem grava; ACK não grava; falha no Supabase não muda a resposta 200 nem o processamento do HubSpot. Não mude nenhum comportamento existente. Trabalhe num branch e me mostre o diff antes do merge. Atualize o `supabase/schema.sql` da integração com a tabela raw_events só como documentação (quem aplica no banco é o repositório do painel). Depois, me passe os comandos de deploy na VPS no padrão do README, incluindo as variáveis SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY e DAILY_NOTES_ENABLED=false no .env de lá.
