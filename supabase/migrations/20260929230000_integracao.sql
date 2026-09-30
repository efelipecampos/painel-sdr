-- Tabelas usadas pela integração PoliChat-Hubspot (repositório separado).
-- A integração ESCREVE nelas; o painel só LÊ. O formato é um contrato com o código
-- da integração: não mude coluna, tipo ou nome sem mudar a integração junto.
-- public.messages: cópia exata de PoliChat-Hubspot/supabase/schema.sql.
-- public.raw_events e GRANTs: cópia exata de docs/integracao-mudancas.md.

create table if not exists public.messages (
  id bigint generated always as identity primary key,

  -- Chaves de deduplicação. A integração grava pelo id externo (wamid do
  -- WhatsApp); o backfill do histórico grava pelo id da Communication no
  -- HubSpot, que é o que existe pra mensagens antigas.
  external_message_id text unique,
  hubspot_communication_id text unique,
  poli_message_uuid text,

  direction text not null check (direction in ('IN', 'OUT')),
  sent_at timestamptz not null,
  text text,
  media_description text,

  is_template boolean not null default false,
  template_name text,
  is_prospecting_opener boolean not null default false,

  lead_phone text,
  lead_name text,
  lead_uuid text,
  deprecated_contact_id text,

  attendant_email text,
  attendant_name text,
  attendant_role text,
  author_name text,

  hubspot_contact_id text,
  hubspot_deal_ids text[],

  -- Resultado do processamento: logged, skipped_not_presales,
  -- alerted_contact_not_found, dry_run, backfill.
  outcome text,

  created_at timestamptz not null default now()
);

create index if not exists messages_sent_at_idx on public.messages (sent_at desc);
create index if not exists messages_contact_idx on public.messages (hubspot_contact_id, sent_at);
create index if not exists messages_attendant_idx on public.messages (attendant_email, sent_at);
create index if not exists messages_template_idx on public.messages (template_name) where template_name is not null;
create index if not exists messages_lead_uuid_idx on public.messages (lead_uuid);

-- Só a service role (usada pelo serviço) escreve e lê por padrão. Para o
-- painel, crie depois uma policy de leitura conforme a necessidade.
alter table public.messages enable row level security;

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

-- Privilégios: o projeto não expõe tabelas novas automaticamente.
grant select, insert, update on public.messages, public.raw_events to service_role;
grant usage, select on all sequences in schema public to service_role;
-- Nada para anon nem authenticated.
