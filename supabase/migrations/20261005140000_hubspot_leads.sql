-- Leads do HubSpot (objeto Lead), sincronizados pelo worker a cada 15 min (só leitura no HubSpot).
-- Uso nesta etapa: tirar de "Aguardando" e "Parados" o lead cujo Lead mais recente no HubSpot está numa
-- etapa configurada em settings.hubspot_excluded_stages (decisão de 2026-10-05: Descartado, DSQ - BR e
-- Qualificado do "[New] Pipeline SDR"). Depois: carteira do SDR (Fase 6).

-- Etapas dos pipelines de Lead (nome e estado), para mostrar a etapa na tela.
create table painel.hubspot_stages (
  stage_id text primary key,
  pipeline_id text not null,
  pipeline_label text,
  label text not null,
  state text,                 -- NEW | IN_PROGRESS | QUALIFIED | UNQUALIFIED
  display_order integer
);

create table painel.hubspot_leads (
  hubspot_lead_id text primary key,
  hubspot_contact_id text,    -- contato associado (liga com painel.leads.hubspot_contact_id)
  pipeline_id text,
  stage_id text,
  owner_id text,
  created_at timestamptz,
  updated_at timestamptz,     -- hs_lastmodifieddate
  synced_at timestamptz not null default now()
);
create index hubspot_leads_contact_idx on painel.hubspot_leads (hubspot_contact_id, created_at desc);

alter table painel.hubspot_stages enable row level security;
alter table painel.hubspot_leads enable row level security;
grant all on painel.hubspot_stages, painel.hubspot_leads to service_role;

-- Lead mais recente de cada contato no HubSpot.
create view painel.contact_hubspot_stage
with (security_invoker = true)
as
select distinct on (h.hubspot_contact_id)
       h.hubspot_contact_id, h.hubspot_lead_id, h.pipeline_id, h.stage_id, s.label as stage_label, h.owner_id
from painel.hubspot_leads h
left join painel.hubspot_stages s on s.stage_id = h.stage_id
where h.hubspot_contact_id is not null
order by h.hubspot_contact_id, h.created_at desc nulls last, h.hubspot_lead_id desc;
grant select on painel.contact_hubspot_stage to service_role;

-- Etapas que tiram o lead de "Aguardando" e "Parados" ([New] Pipeline SDR: Descartado, DSQ - BR, Qualificado).
insert into painel.settings (key, value) values
  ('hubspot_excluded_stages', '["1250901141", "1250901142", "1358962969"]')
on conflict (key) do nothing;

-- O lead (painel.leads) está numa etapa excluída no HubSpot? Devolve o nome da etapa, ou null.
create function painel.hubspot_excluded_stage(p_hubspot_contact_id text)
returns text
language sql
stable
set search_path = ''
as $$
  select v.stage_label
  from painel.contact_hubspot_stage v
  where p_hubspot_contact_id is not null
    and v.hubspot_contact_id = p_hubspot_contact_id
    and v.stage_id in (
      select jsonb_array_elements_text(s.value) from painel.settings s where s.key = 'hubspot_excluded_stages'
    );
$$;
revoke execute on function painel.hubspot_excluded_stage(text) from public, anon, authenticated;
grant execute on function painel.hubspot_excluded_stage(text) to service_role;
