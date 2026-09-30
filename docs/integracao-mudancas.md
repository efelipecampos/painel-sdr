# Mudança na integração PoliChat-Hubspot

Esta mudança é feita no repositório `PoliChat-Hubspot`, numa sessão do Claude Code aberta NAQUELA pasta. Não no repositório do painel.

## Objetivo

Gravar o corpo cru dos eventos da Poli que são da equipe de pré-vendas (SDRs, closers e o app token) em `public.raw_events` no Supabase, para o painel reconstruir chats, donos, status e tempos de resposta. Hoje a integração descarta justamente o que o painel precisa: eventos `SYSTEM` (transferências, abertura e encerramento), eventos que não são mensagem, e os campos `attendance.uuid`, `attendance.status` e `author.type`.

## Regras

- O fluxo atual (HubSpot, Google Chat, `public.messages`, nota diária) não muda em nada.
- A gravação em `raw_events` acontece logo depois da validação da assinatura, sem depender dos filtros do fluxo do HubSpot (direção, schema, etc.). Ela tem o filtro próprio abaixo.
- **Filtro (decisão do Felipe, 2026-09-30): só grava o que é da equipe de pré-vendas.** Grave o evento quando ele for `received`, `sent` ou mensagem `SYSTEM` E atender a pelo menos uma destas condições:
  1. **Dono do chat é da equipe:** `value.attendance.attendant.email` está em `POLI_SDR_EMAILS` ou `POLI_CLOSER_EMAILS` (use `getAttendantRole` de `src/config/team.ts`). Isso vale para qualquer autor: mensagem do lead, do SDR/closer, template, bot ou evento SYSTEM. Enquanto o dono for da equipe, a conversa inteira entra.
  2. **Enviado pelo app token do Felipe:** toda mensagem que o bot envia usando o app token do Felipe (hoje, os templates comerciais) é gravada, mesmo que o chat não tenha dono da equipe. A forma de reconhecer o app token no payload ainda não está confirmada: antes de implementar, descubra nos eventos reais qual campo identifica o app token (ex.: `author.uuid`, `author.type`, e-mail do autor) e mostre ao Felipe, sem conteúdo de mensagem e sem telefone. O identificador vai numa variável de ambiente nova (ex.: `POLI_APP_TOKEN_AUTHOR_UUIDS`), nunca fixo no código. Se o payload não tiver como distinguir o app token, este item não é implementado: avise o Felipe e siga só com os itens 1 e 3.
  3. **Saída do chat da equipe:** evento `SYSTEM` (transferência, encerramento) de um atendimento (`value.attendance.uuid`) que já tem evento gravado em `raw_events`. Sem isso, o painel não sabe que o chat saiu do SDR e continua achando que ele é o dono. Só eventos SYSTEM entram por esta regra; mensagens depois que o chat saiu da equipe não entram.
- Fica de fora: eventos de ACK de entrega/leitura, atualização de mensagem, eventos que não são de mensagem (ex.: `contacts.contact.updated`) e qualquer mensagem de chat cujo dono não é da equipe (suporte, CS, outros times), exceto as dos itens 2 e 3.
- Consequência aceita: se o lead responder enquanto o chat está sem dono da equipe (ex.: respondeu ao template do app token antes de um SDR assumir), essa resposta não é gravada.
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

> Leia o README, o `src/server.ts` e o arquivo `/Users/felipecampos/orca/Painel-de-SDR/docs/integracao-mudancas.md`. Quero adicionar a gravação do evento cru da Poli em `public.raw_events` no Supabase, seguindo exatamente esse arquivo, inclusive o filtro da equipe de pré-vendas. As tabelas `public.messages` e `public.raw_events` JÁ EXISTEM no Supabase (criadas pelas migrations do repositório do painel): não crie nem altere tabela no banco. Antes de codar: (1) descubra nos eventos reais como reconhecer uma mensagem enviada pelo app token e me mostre os campos de autor que encontrou, sem conteúdo de mensagem e sem telefone; (2) me mostre onde no `server.ts` a gravação entra, como o filtro é aplicado e como ela usa a fila SQLite em caso de falha. Escreva testes: mensagem do lead em chat com dono SDR grava; mensagem do SDR grava; mensagem em chat com dono closer grava; mensagem em chat com dono fora da equipe não grava; mensagem do bot enviada pelo app token grava mesmo sem dono da equipe; evento SYSTEM que tira o chat da equipe grava quando o atendimento já tem evento gravado; evento não-mensagem não grava; ACK não grava; reentrega do mesmo evento não duplica; falha no Supabase não muda a resposta 200 nem o processamento do HubSpot. Não mude nenhum comportamento existente. Trabalhe num branch e me mostre o diff antes do merge. Atualize o `supabase/schema.sql` da integração com a tabela raw_events só como documentação. Depois, me passe os comandos de deploy na VPS no padrão do README, incluindo as variáveis SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DAILY_NOTES_ENABLED=false e a variável nova do app token no .env de lá.
