-- Fase 10e.1: Reunião no HubSpot para cada reunião do painel (docs/agendamento.md, seção 2, decisões de 2026-10-07).
-- O worker cria a Reunião logo depois do agendamento e a atualiza quando o horário ou o closer mudam
-- (hubspot_sync_needed). O status (hs_meeting_outcome) vai uma vez por dia, na rodada das 17:55.
alter table painel.meetings
  add column hubspot_sync_needed boolean not null default false,  -- criar/atualizar no HubSpot na próxima rodada
  add column hubspot_synced_at timestamptz,
  add column hubspot_status_synced text,   -- último status enviado ao HubSpot (rodada das 17:55)
  add column hubspot_error text;           -- último erro do HubSpot (sem dado de lead)
create index meetings_hubspot_sync_idx on painel.meetings (id) where source = 'painel' and hubspot_sync_needed;

insert into painel.settings (key, value) values
  ('hubspot_status_sync_time', '"17:55"'),  -- hora (fuso de negócio) da rodada diária de status
  ('hubspot_status_sync_day', '""')         -- último dia em que a rodada rodou (controle do worker)
on conflict (key) do nothing;
