-- Fase 11, jornada configurável (docs/jornada.md, 2026-10-15): o gestor diz o que o painel envia quando o lead
-- clica num botão de um template, e o worker envia pela API do Poli. Só gestor e admin veem e configuram.
-- O worker (service_role) lê as regras e grava os envios. Nada de telefone nem texto de mensagem nos registros.

-- Templates do Poli (cópia da listagem da API, atualizada pelo worker). Alimenta a tela de regras.
create table painel.poli_templates (
  uuid text primary key,                       -- template_uuid no Poli
  key text not null,                           -- nome do template (#abertura_...)
  status text,                                 -- VALIDATED, NOT_VERIFIED...
  category text,                               -- MARKETING, UTILITY...
  body text,                                   -- texto do template (copy de marketing, com as [variáveis])
  buttons jsonb not null default '[]',         -- [{"text": "Eu e mais 1"}, ...] só os de resposta
  synced_at timestamptz not null default now()
);

create type painel.journey_window as enum ('expediente', 'fora', 'sempre');
create type painel.journey_rule_status as enum ('teste', 'ativa', 'pausada');

-- Regra: quando o lead clicar em <botão> do <template de origem>, no <horário>, enviar <template de destino>.
create table painel.journey_rules (
  id uuid primary key default gen_random_uuid(),
  origin_template_uuid text not null,
  origin_button text not null,                 -- texto do botão, como aparece no template
  janela painel.journey_window not null default 'sempre',
  dest_template_uuid text not null,
  status painel.journey_rule_status not null default 'teste',
  daily_limit integer check (daily_limit is null or daily_limit > 0),  -- null = sem limite (decisão de 15/10)
  paused_reason text,                          -- 'limite_diario' quando o worker pausa sozinho
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  unique (origin_template_uuid, origin_button, janela)
);

-- Histórico de cada regra: quem criou, mudou, ativou ou pausou, e quando.
create table painel.journey_rule_changes (
  id bigint generated always as identity primary key,
  rule_id uuid not null references painel.journey_rules (id) on delete cascade,
  action text not null check (action in ('criou', 'mudou', 'ativou', 'pausou', 'retomou', 'pausou_limite', 'voltou_teste')),
  changed_at timestamptz not null default now(),
  changed_by uuid,                             -- null quando foi o worker (limite diário)
  before jsonb,
  after jsonb
);
create index journey_rule_changes_rule_idx on painel.journey_rule_changes (rule_id, changed_at desc);

create type painel.journey_send_status as enum ('enviado', 'falhou', 'pulado');

-- Cada clique que bateu numa regra vira uma linha: enviado, falhou (com o código) ou pulado (com o motivo).
create table painel.journey_sends (
  id bigint generated always as identity primary key,
  rule_id uuid not null references painel.journey_rules (id) on delete restrict,
  click_event_id bigint not null references public.raw_events (id),   -- o evento do clique
  poli_contact_uuid text not null,
  lead_id uuid references painel.leads (id),
  sdr_id uuid references painel.sdrs (id),     -- SDR dona do lead no momento do envio
  clicked_at timestamptz not null,
  mode text not null check (mode in ('teste', 'real')),
  status painel.journey_send_status not null,
  reason text,                                 -- pulado: 'equipe_ja_escreveu', 'sem_dono', 'pausada'...; falhou: motivo do Poli
  http_status integer,
  poli_message_uuid text,
  created_at timestamptz not null default now(),
  unique (rule_id, click_event_id)             -- o mesmo clique nunca é processado duas vezes
);
-- A mesma regra nunca envia duas vezes de verdade para o mesmo lead.
create unique index journey_sends_uma_vez_por_lead on painel.journey_sends (rule_id, poli_contact_uuid)
  where mode = 'real' and status = 'enviado';
create index journey_sends_regra_dia_idx on painel.journey_sends (rule_id, created_at);

-- Pausa geral e telefone de teste: uma linha só, editável por gestor e admin (painel.settings só o admin edita).
create table painel.journey_config (
  id boolean primary key default true check (id),
  paused boolean not null default false,
  test_phone text,                             -- WhatsApp que recebe as mensagens das regras em teste (da equipe)
  updated_at timestamptz not null default now(),
  updated_by uuid
);
insert into painel.journey_config (id) values (true);

-- Último raw_events.id de clique que o worker já olhou (só o worker usa).
insert into painel.settings (key, value) values ('journey_cursor', '0'::jsonb) on conflict (key) do nothing;

-- Quem mudou e quando.
create trigger journey_rules_touch before insert or update on painel.journey_rules
  for each row execute function painel.touch_updated();
create trigger journey_config_touch before insert or update on painel.journey_config
  for each row execute function painel.touch_updated();

-- Acesso.
alter table painel.poli_templates enable row level security;
alter table painel.journey_rules enable row level security;
alter table painel.journey_rule_changes enable row level security;
alter table painel.journey_sends enable row level security;
alter table painel.journey_config enable row level security;

grant all on painel.poli_templates, painel.journey_rules, painel.journey_rule_changes, painel.journey_sends, painel.journey_config to service_role;
grant usage, select on all sequences in schema painel to service_role;

grant select on painel.poli_templates, painel.journey_sends, painel.journey_rule_changes to authenticated;
grant select, insert, update on painel.journey_rules to authenticated;
grant select, update on painel.journey_config to authenticated;
grant insert on painel.journey_rule_changes to authenticated;
grant usage on sequence painel.journey_rule_changes_id_seq to authenticated;

create policy poli_templates_manager on painel.poli_templates for select to authenticated
  using ((select painel.is_manager()));
create policy journey_rules_manager on painel.journey_rules for all to authenticated
  using ((select painel.is_manager())) with check ((select painel.is_manager()));
create policy journey_rule_changes_manager_read on painel.journey_rule_changes for select to authenticated
  using ((select painel.is_manager()));
create policy journey_rule_changes_manager_write on painel.journey_rule_changes for insert to authenticated
  with check ((select painel.is_manager()));
create policy journey_sends_manager on painel.journey_sends for select to authenticated
  using ((select painel.is_manager()));
create policy journey_config_manager on painel.journey_config for all to authenticated
  using ((select painel.is_manager())) with check ((select painel.is_manager()));
