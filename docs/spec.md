# Especificação técnica — Painel SDR (V1)

## 1. Visão geral

```
Poli Chat ──webhook──▶ PoliChat-Hubspot (já em produção) ──▶ HubSpot (como hoje)
                                   │
                                   ├──▶ public.messages   (espelho que já existe)
                                   └──▶ public.raw_events (NOVO: evento cru, só da equipe de pré-vendas)
                                                 │
Painel worker ◀──────────────────────────────────┘ lê e monta o schema painel
Poli API  ──backfill / conferência diária (worker do painel)──▶ painel.*
HubSpot   ──sync de reuniões a cada 15 min (worker do painel)──▶ painel.meetings
Claude    ◀──job de hora em hora (worker do painel)──▶ painel.lead_scores
Navegador ──Supabase Auth + RPC (RLS)──▶ funções de métricas ──▶ telas
```

| Serviço | Repositório | O que faz |
|---|---|---|
| `poli-hubspot` | `PoliChat-Hubspot` (existente) | Recebe o webhook da Poli, registra no HubSpot, espelha em `public.messages` e, depois da mudança descrita em `docs/integracao-mudancas.md`, grava o evento cru em `public.raw_events`. |
| `painel-web` | este | Next.js: telas, login, ações do usuário (status de reunião, configurações). |
| `painel-worker` | este | Lê `public.raw_events`, monta as tabelas do schema `painel`, calcula tempos de resposta, sincroniza reuniões do HubSpot, roda o score e a conferência com a API da Poli. |

Na VPS, o Coolify (Traefik) já faz o roteamento por domínio e o HTTPS. O Supabase é gerenciado (supabase.com), não roda na VPS.

### O que o payload da Poli já traz (visto nos exemplos reais da integração)

- `value.attendance.uuid`: ID do atendimento. É o "chat" deste projeto.
- `value.attendance.status` (ex.: `IN_PROGRESS`, pode vir null), `type`, `closed_reason`.
- `value.attendance.attendant`: `uuid`, `email`, `name` do atendente responsável no momento da mensagem.
- `value.author.type`: `CONTACT` (lead), `USER` (atendente). Mensagens automáticas vêm sem `author.uuid`.
- `value.template`: preenchido quando a mensagem é template (`key` é o nome).
- `value.direction`: `IN`, `OUT` ou `SYSTEM` (transferências e eventos do sistema; hoje a integração descarta).
- `value.contact`: `uuid`, `name`, `phone`, `origin_category`, `from_campaign`.
- Eventos que não são mensagem (ex.: `contacts.contact.updated`) também chegam; a integração hoje só loga.

O papel do atendente (SDR ou Closer) vem das listas `POLI_SDR_EMAILS` / `POLI_CLOSER_EMAILS` da integração. O painel usa a mesma regra (tabela `painel.sdrs`).

## 2. Definições das métricas (V1)

Estas definições foram fechadas como padrão da V1. Qualquer mudança é decisão do Felipe.

**Período**: sempre `[de, até]` escolhido na tela, no fuso `America/Sao_Paulo`. Padrão: hoje, 00:00 a 23:59. Nas funções, o intervalo é semiaberto: `[de, até)`.

**Dono do lead (SDR)**: o atendente responsável pelo chat no Poli **no momento de cada evento**. Cada mensagem guarda o SDR responsável naquele instante. Se o chat for transferido para um closer, o que acontece depois disso não conta para o SDR.

**Chat**: a conversa identificada pelo ID de chat/atendimento da Poli. Se a Poli abrir um novo atendimento com novo ID, é um novo chat. Transferência na Poli encerra o atendimento e abre outro (`INITIATED_BY_FORWARDING`), então cada transferência gera um chat novo.

| Métrica | Definição |
|---|---|
| Leads abordados | Leads distintos que receberam ao menos 1 template enviado pelo SDR dentro do período. Um lead abordado duas vezes conta uma vez. |
| Templates enviados | Total de mensagens de template enviadas pelo SDR no período (conta repetidos). |
| Leads que responderam | Leads distintos que mandaram pelo menos 1 mensagem em chat do SDR (dono no momento da mensagem) dentro do período. |
| Tempo de resposta (mediana) | **Mediana**, no período, do tempo entre o **início de um bloco de mensagens do lead** e a **próxima mensagem da equipe para o mesmo lead**, em qualquer atendimento dele. Mensagem da equipe = mensagem escrita por uma pessoa (SDR, closer ou gestor; não precisa ser o dono do chat) ou template enviado manualmente por uma pessoa. Template do app token, mensagens de bot, automações e eventos de sistema (nota interna, resumo, transferência) NÃO contam como resposta e não interrompem o bloco. Bloco = sequência de mensagens do lead sem mensagem da equipe no meio; o relógio começa na primeira mensagem do bloco. O tempo é creditado ao SDR dono do atendimento onde o lead escreveu, no momento da primeira mensagem do bloco. Entra no período pelo horário da resposta. Blocos ainda sem resposta não entram (entram em "Aguardando"). |
| Tempo de primeira resposta (mediana) | Mesmo cálculo, mas só para o bloco que começa na **primeira mensagem do lead em cada atendimento**. Caso típico: o app token dispara o template no cadastro, o lead responde quando quiser, e mede-se da resposta do lead até a primeira mensagem da equipe. |
| Aguardando resposta | Chats **abertos**, com o SDR como responsável agora, cuja última mensagem do lead ou da equipe é do lead. Estado atual (não depende do período). Aberto = sem evento de encerramento da Poli e sem mensagem do lead ou da equipe em outro atendimento do mesmo lead depois da última atividade deste (a Poli às vezes mantém mais de um atendimento do mesmo lead sem encerrar o antigo). |
| Parados há +X min | Subconjunto de "Aguardando" em que o tempo desde o início do bloco sem resposta passa do limite configurado (padrão 30 min). Se "contar só horário comercial" estiver ligado nas configurações, esse tempo é contado em horário comercial. |
| Carteira | Leads em aberto no funil do SDR no HubSpot (carteira protegida por 30 dias: lead que converte de novo no site nesse prazo volta para o mesmo SDR). Vem do HubSpot, entra na Fase 6. |
| Qualidade da carteira | Média do score mais recente de cada lead da carteira atual do SDR. Leads sem nenhuma mensagem do lead ficam fora e aparecem como "não analisados". |
| Reuniões | Chats com status de reunião preenchido no período (pela data da última mudança de status). Taxa = reuniões ÷ leads abordados. Conversão para análise de padrão = status **Validada**. |

**Horário comercial**: quando o filtro "Só horário comercial" está ligado, cada intervalo de tempo conta apenas os segundos dentro dos horários configurados por dia da semana, excluindo feriados cadastrados. Com o filtro desligado, conta 24h corrido. Os dois valores são gravados em cada evento de resposta, para o filtro não precisar recalcular nada.

## 3. Schema (Postgres / Supabase)

Rascunho. O Claude Code transforma isto em migrations, revisando tipos e índices.

- Todas as tabelas abaixo ficam no schema `painel` (`create schema painel;`), inclusive os tipos. `profiles` também.
- `public.messages` e `public.raw_events` são criadas pela PRIMEIRA migration deste repositório (`..._integracao.sql`), com o SQL exato de `docs/integracao-mudancas.md`. A integração escreve nelas; o painel só lê.
- Como o projeto foi criado com "Automatically expose new tables" desligado, nenhuma tabela nova recebe privilégio automático. Dê GRANT explícito ao `service_role` em tudo que a integração e o worker usam (tabelas e sequências), e ao `authenticated` só nas RPCs e tabelas da tela.
- A tabela de mensagens do painel se chama `painel.chat_messages`, para não confundir com `public.messages`.
- Para a Data API enxergar o schema `painel`, ele precisa ser adicionado em Settings → API → Exposed schemas, e os GRANTs dados só para o role `authenticated`.

```sql
-- Perfis de acesso (1:1 com auth.users)
create type app_role as enum ('admin', 'gestor');
create table profiles (
  id uuid primary key references auth.users on delete cascade,
  name text not null,
  role app_role not null default 'gestor',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- SDRs (vindos dos atendentes da Poli)
create table sdrs (
  id uuid primary key default gen_random_uuid(),
  poli_attendant_uuid text unique,             -- value.attendance.attendant.uuid
  poli_email text unique not null,
  name text not null,
  email text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table leads (
  id uuid primary key default gen_random_uuid(),
  poli_contact_uuid text unique not null,      -- value.contact.uuid
  name text,
  company text,
  phone_e164 text,
  hubspot_contact_id text,
  created_at timestamptz not null default now()
);
create index on leads (phone_e164);

create type chat_status as enum ('open','closed');
create table chats (
  id uuid primary key default gen_random_uuid(),
  poli_attendance_uuid text unique not null,   -- value.attendance.uuid
  lead_id uuid not null references leads,
  sdr_id uuid references sdrs,            -- responsável atual
  status chat_status not null default 'open',
  opened_at timestamptz not null,
  closed_at timestamptz,
  last_message_at timestamptz,
  last_message_from text                  -- 'lead' | 'sdr' | 'bot' | 'template' | 'system'
);
create index on chats (sdr_id, status);

create table chat_owner_history (
  id bigint generated always as identity primary key,
  chat_id uuid not null references chats,
  sdr_id uuid references sdrs,
  from_at timestamptz not null,
  to_at timestamptz
);

create type sender_type as enum ('lead','sdr','bot','template','system');
create table chat_messages (
  id uuid primary key default gen_random_uuid(),
  poli_message_id text unique not null,
  raw_event_id bigint,                    -- public.raw_events.id de origem
  chat_id uuid not null references chats,
  lead_id uuid not null references leads,
  sdr_id uuid references sdrs,            -- responsável no momento da mensagem
  sender sender_type not null,
  template_name text,
  body text,
  sent_at timestamptz not null
);
create index on chat_messages (chat_id, sent_at);
create index on chat_messages (sdr_id, sent_at);

-- Pares bloco do lead → resposta humana do SDR (gerado pelo worker)
create table response_events (
  id bigint generated always as identity primary key,
  chat_id uuid not null references chats,
  sdr_id uuid not null references sdrs,
  lead_block_started_at timestamptz not null,
  replied_at timestamptz not null,
  is_first_response boolean not null,
  seconds_24h integer not null,
  seconds_business integer not null,
  unique (chat_id, lead_block_started_at)
);
create index on response_events (sdr_id, replied_at);

-- Configurações
create table business_hours (
  weekday smallint primary key check (weekday between 0 and 6),  -- 0 = domingo
  enabled boolean not null,
  start_time time not null,
  end_time time not null
);
create table holidays (day date primary key, name text not null);
create table settings (key text primary key, value jsonb not null, updated_at timestamptz default now(), updated_by uuid);
-- chaves: 'timezone', 'stale_minutes', 'stale_business_only', 'holidays_off', 'quality_context', 'quality_skip_no_reply'

create table quality_criteria (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text not null,
  weight integer not null check (weight between 0 and 100),
  sort integer not null default 0,
  active boolean not null default true
);

create table lead_scores (
  id bigint generated always as identity primary key,
  lead_id uuid not null references leads,
  score integer not null check (score between 0 and 100),
  criteria_scores jsonb not null,         -- [{criterion_id, score, justificativa}]
  summary text,
  model text not null,
  criteria_version text not null,         -- hash dos critérios + contexto usados
  based_on_message_at timestamptz not null,
  input_tokens integer, output_tokens integer,
  scored_at timestamptz not null default now()
);
create index on lead_scores (lead_id, scored_at desc);

-- Reuniões
create type meeting_status as enum ('agendada','validada','noshow','invalidada','cancelada');
create table meetings (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references chats,
  lead_id uuid not null references leads,
  sdr_id uuid references sdrs,
  status meeting_status not null,
  source text not null check (source in ('hubspot','manual')),
  hubspot_meeting_id text unique,
  scheduled_for timestamptz,
  status_changed_at timestamptz not null default now(),
  status_changed_by uuid references profiles
);
create table meeting_status_history (
  id bigint generated always as identity primary key,
  meeting_id uuid not null references meetings,
  from_status meeting_status,
  to_status meeting_status,
  source text not null,
  changed_by uuid references profiles,
  changed_at timestamptz not null default now()
);
```

### Funções (RPC) que a tela consome

- `business_seconds(from timestamptz, to timestamptz) returns integer`: segundos dentro do horário comercial, considerando `business_hours`, `holidays` e o fuso.
- `sdr_metrics(p_from timestamptz, p_to timestamptz, p_business_only boolean)`: uma linha por SDR ativo com as 7 métricas e os campos do card.
- `team_metrics(...)`: a linha "Time".
- `sdr_chats(p_sdr uuid, p_from, p_to, p_business_only, p_filter text, p_search text, p_limit, p_offset)`: a tabela da tela do SDR.
- `set_meeting_status(p_chat uuid, p_status meeting_status or null)`: grava a mudança e o histórico. Checa permissão.

### RLS

- Todas as tabelas com RLS ligado.
- Leitura: usuário autenticado com `profiles.active = true`.
- Escrita de `settings`, `business_hours`, `holidays`, `quality_criteria`: só `role = 'admin'`.
- Escrita de status de reunião: `admin` e `gestor`, sempre via `set_meeting_status`.
- `chat_messages`, `response_events`, `lead_scores`: escrita só pelo `service_role` (worker do painel).
- `public.raw_events` e `public.messages`: sem nenhum GRANT para `authenticated` ou `anon`. Só o `service_role` lê.
- Não existe cadastro aberto. Usuários são convidados pelo admin (Supabase Auth, e-mail).

## 4. Ingestão do Poli Chat

A entrada é a integração `PoliChat-Hubspot`, que já recebe o webhook da Poli. A única mudança nela está em `docs/integracao-mudancas.md`: gravar o corpo cru dos eventos da equipe de pré-vendas em `public.raw_events` (dono do chat é SDR ou closer, mensagens do app token e o evento SYSTEM que tira o chat da equipe; regra completa no documento).

No painel:

1. O worker lê `public.raw_events` ainda não consumidos (cursor por `id`, guardado em `painel.settings` na chave `raw_events_cursor`), em ordem.
2. Para cada evento de mensagem, faz upsert de `sdrs`, `leads`, `chats`, `chat_messages`, atualiza `chat_owner_history` e `chats.last_message_*`. Classificação do remetente: `author.type = CONTACT` → lead; `template` preenchido → template; `author.type = USER` com `author.uuid` → SDR (humano); sem `author.uuid` → bot/automação; `direction = SYSTEM` → system (transferência, abertura, encerramento).
   `leads.hubspot_contact_id`: pegue de `public.messages` pelo `external_message_id` (a integração já resolve o contato no HubSpot com matching em 4 camadas). Não refaça esse matching.
3. A cada mensagem humana do SDR, fecha o bloco do lead em aberto naquele chat e grava um `response_events`.
4. Status do chat: pelo `attendance.status`, `closed_reason` e pelos eventos SYSTEM. Os valores exatos de status e os tipos de evento SYSTEM saem da análise dos eventos reais em `raw_events` (Fase 3).
5. Histórico anterior ao `raw_events`: não há backfill na V1 (decisão de 2026-10-05). O painel começa no primeiro evento de `raw_events` (01/10/2026). A API da Poli fica para depois.
6. Conferência diária (madrugada): compara a API da Poli com o banco nas últimas 48 h e completa o que faltar.

## 5. HubSpot (reuniões)

- Private App com token de leitura para contatos e reuniões (o Claude Code confere os escopos exatos na documentação atual).
- A cada 15 min, o worker busca reuniões modificadas desde a última sincronização, com o contato associado.
- Ligação reunião → lead pelo `hubspot_contact_id` (vindo da integração). Telefone normalizado só como reserva; reaproveite `src/hubspot/phone.ts` da integração.
- Mapeamento do resultado da reunião no HubSpot: agendada/reagendada → `agendada`; no show → `noshow`; cancelada → `cancelada`. Realizada não vira "validada" automaticamente.
- `validada` e `invalidada` são sempre manuais. Depois que um status manual foi gravado, o sync do HubSpot não o sobrescreve; registra o conflito em log.
- Toda mudança gera linha em `meeting_status_history`.

## 6. Score de qualidade (Claude)

- Job de hora em hora no worker.
- Seleciona leads com mensagem nova desde o último score e que tenham ao menos 1 mensagem do lead.
- Monta o prompt com: `settings.quality_context`, os critérios ativos (nome, descrição, peso) e a transcrição do chat (limitar às últimas N mensagens / N caracteres; sem telefone).
- Pede resposta em JSON: nota 0–100 e justificativa curta por critério. O score final é a média ponderada calculada no código, não pelo modelo.
- Grava `criteria_version` (hash dos critérios + contexto). Critério mudou → todos os leads são reavaliados na próxima rodada.
- Controle de custo: limite de leads por rodada, registro de tokens por chamada, e modelo em `ANTHROPIC_MODEL` (começar pelo modelo mais barato que der resultado consistente).

## 7. Telas

Reproduzir `design/Main.dc.html`, `design/SDR.dc.html` e `design/Configuracoes.dc.html` com as cores e fontes de `design/tokens.json` (tema escuro, fonte Rubik). A cor laranja `#f0a93b` de "parado" é uma adição ao design system.

- `/login`: e-mail (link mágico ou senha).
- `/`: painel com filtros de período, "Só horário comercial", ordenação, linha do time e cards por SDR. Atualiza sozinho a cada 60 s.
- `/sdr/[id]`: indicadores do SDR, tabela de chats com filtros, busca, paginação e seletor de status de reunião.
- `/configuracoes` (só admin): horário comercial, feriados, limite de "parado", contexto e critérios de qualidade.

## 8. Deploy

- A VPS já roda Coolify. O Traefik dele cuida do domínio e do HTTPS. Não suba Caddy nem Nginx.
- Mesmo padrão do `PoliChat-Hubspot`: `docker-compose.yml` sem portas publicadas, na rede externa `coolify`, com labels do Traefik para o domínio do painel (ex.: `painel.camposai.com.br`) e `certresolver=letsencrypt`.
- DNS: registro `A` do subdomínio do painel apontando para o IP da VPS, antes do primeiro deploy.
- Serviços: `painel-web` (com labels do Traefik) e `painel-worker` (sem labels, não recebe tráfego).
- V1: deploy manual (rsync ou git pull na VPS + `docker compose up -d --build`), igual à integração.
- Logs: `docker compose logs`. Alerta mínimo: o worker avisa quando o cursor de `raw_events` fica parado com eventos pendentes.

## 9. Variáveis de ambiente

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=        # só web (server) e worker
# Projeto: https://pabbgxaphooftdsdewmq.supabase.co
POLI_API_BASE_URL=
POLI_API_TOKEN=
HUBSPOT_PRIVATE_APP_TOKEN=
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=
APP_DOMAIN=
```

## 10. LGPD

- Conteúdo de conversa e telefone são dados pessoais. Acesso só autenticado, RLS em tudo.
- Não enviar telefone ao Claude. Não logar conteúdo de mensagem.
- Definir retenção (ex.: apagar `body` de mensagens com mais de 12 meses, mantendo os números agregados). Decisão do Felipe.
