-- Schema do painel: tabelas, tipos e índices (docs/spec.md, seção 3).
-- RLS ligado em todas as tabelas. As regras de acesso ficam na migration painel_rls.

create schema if not exists painel;

-- Perfis de acesso (1:1 com auth.users)
create type painel.app_role as enum ('admin', 'gestor');
create table painel.profiles (
  id uuid primary key references auth.users on delete cascade,
  name text not null,
  role painel.app_role not null default 'gestor',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- SDRs (vindos dos atendentes da Poli)
create table painel.sdrs (
  id uuid primary key default gen_random_uuid(),
  poli_attendant_uuid text unique,             -- value.attendance.attendant.uuid
  poli_email text unique not null,
  name text not null,
  email text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table painel.leads (
  id uuid primary key default gen_random_uuid(),
  poli_contact_uuid text unique not null,      -- value.contact.uuid
  name text,
  company text,
  phone_e164 text,
  hubspot_contact_id text,
  created_at timestamptz not null default now()
);
create index leads_phone_e164_idx on painel.leads (phone_e164);
create index leads_hubspot_contact_id_idx on painel.leads (hubspot_contact_id);

create type painel.chat_status as enum ('open', 'closed');
create table painel.chats (
  id uuid primary key default gen_random_uuid(),
  poli_attendance_uuid text unique not null,   -- value.attendance.uuid
  lead_id uuid not null references painel.leads,
  sdr_id uuid references painel.sdrs,          -- responsável atual
  status painel.chat_status not null default 'open',
  opened_at timestamptz not null,
  closed_at timestamptz,
  last_message_at timestamptz,
  last_message_from text                       -- 'lead' | 'sdr' | 'bot' | 'template' | 'system'
);
create index chats_sdr_status_idx on painel.chats (sdr_id, status);
create index chats_lead_idx on painel.chats (lead_id);

create table painel.chat_owner_history (
  id bigint generated always as identity primary key,
  chat_id uuid not null references painel.chats,
  sdr_id uuid references painel.sdrs,
  from_at timestamptz not null,
  to_at timestamptz
);
create index chat_owner_history_chat_idx on painel.chat_owner_history (chat_id, from_at);
create index chat_owner_history_sdr_idx on painel.chat_owner_history (sdr_id);

create type painel.sender_type as enum ('lead', 'sdr', 'bot', 'template', 'system');
create table painel.chat_messages (
  id uuid primary key default gen_random_uuid(),
  poli_message_id text unique not null,
  raw_event_id bigint,                         -- public.raw_events.id de origem
  chat_id uuid not null references painel.chats,
  lead_id uuid not null references painel.leads,
  sdr_id uuid references painel.sdrs,          -- responsável no momento da mensagem
  sender painel.sender_type not null,
  template_name text,
  body text,
  sent_at timestamptz not null
);
create index chat_messages_chat_sent_idx on painel.chat_messages (chat_id, sent_at);
create index chat_messages_sdr_sent_idx on painel.chat_messages (sdr_id, sent_at);
create index chat_messages_lead_idx on painel.chat_messages (lead_id);

-- Pares bloco do lead → resposta humana do SDR (gerado pelo worker)
create table painel.response_events (
  id bigint generated always as identity primary key,
  chat_id uuid not null references painel.chats,
  sdr_id uuid not null references painel.sdrs,
  lead_block_started_at timestamptz not null,
  replied_at timestamptz not null,
  is_first_response boolean not null,
  seconds_24h integer not null,
  seconds_business integer not null,
  unique (chat_id, lead_block_started_at)
);
create index response_events_sdr_replied_idx on painel.response_events (sdr_id, replied_at);

-- Configurações
create table painel.business_hours (
  weekday smallint primary key check (weekday between 0 and 6),  -- 0 = domingo
  enabled boolean not null,
  start_time time not null,
  end_time time not null,
  check (end_time > start_time)
);
create table painel.holidays (
  day date primary key,
  name text not null
);
create table painel.settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz default now(),
  updated_by uuid
);
-- chaves: 'timezone', 'stale_minutes', 'stale_business_only', 'holidays_off',
-- 'quality_context', 'quality_skip_no_reply', 'raw_events_cursor'

create table painel.quality_criteria (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text not null,
  weight integer not null check (weight between 0 and 100),
  sort integer not null default 0,
  active boolean not null default true
);

create table painel.lead_scores (
  id bigint generated always as identity primary key,
  lead_id uuid not null references painel.leads,
  score integer not null check (score between 0 and 100),
  criteria_scores jsonb not null,              -- [{criterion_id, score, justificativa}]
  summary text,
  model text not null,
  criteria_version text not null,              -- hash dos critérios + contexto usados
  based_on_message_at timestamptz not null,
  input_tokens integer,
  output_tokens integer,
  scored_at timestamptz not null default now()
);
create index lead_scores_lead_scored_idx on painel.lead_scores (lead_id, scored_at desc);

-- Reuniões
create type painel.meeting_status as enum ('agendada', 'validada', 'noshow', 'invalidada', 'cancelada');
create table painel.meetings (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references painel.chats,
  lead_id uuid not null references painel.leads,
  sdr_id uuid references painel.sdrs,
  status painel.meeting_status not null,
  source text not null check (source in ('hubspot', 'manual')),
  hubspot_meeting_id text unique,
  scheduled_for timestamptz,
  status_changed_at timestamptz not null default now(),
  status_changed_by uuid references painel.profiles
);
create index meetings_chat_idx on painel.meetings (chat_id);
create index meetings_lead_idx on painel.meetings (lead_id);
create index meetings_sdr_changed_idx on painel.meetings (sdr_id, status_changed_at);

create table painel.meeting_status_history (
  id bigint generated always as identity primary key,
  meeting_id uuid not null references painel.meetings,
  from_status painel.meeting_status,
  to_status painel.meeting_status,
  source text not null,
  changed_by uuid references painel.profiles,
  changed_at timestamptz not null default now()
);
create index meeting_status_history_meeting_idx on painel.meeting_status_history (meeting_id, changed_at);

-- RLS em todas as tabelas do schema.
alter table painel.profiles enable row level security;
alter table painel.sdrs enable row level security;
alter table painel.leads enable row level security;
alter table painel.chats enable row level security;
alter table painel.chat_owner_history enable row level security;
alter table painel.chat_messages enable row level security;
alter table painel.response_events enable row level security;
alter table painel.business_hours enable row level security;
alter table painel.holidays enable row level security;
alter table painel.settings enable row level security;
alter table painel.quality_criteria enable row level security;
alter table painel.lead_scores enable row level security;
alter table painel.meetings enable row level security;
alter table painel.meeting_status_history enable row level security;
