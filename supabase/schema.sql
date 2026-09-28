-- Esquema do espelho de mensagens no Supabase.
-- Rode uma vez no SQL Editor do projeto (Supabase → SQL Editor → New query).
-- Pode ser rodado de novo sem problema: tudo é "if not exists".

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
