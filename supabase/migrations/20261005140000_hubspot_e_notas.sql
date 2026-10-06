-- Leads do HubSpot (objeto Lead), sincronizados pelo worker a cada 15 min (só leitura no HubSpot),
-- e marcação de descarte por nota interna da Poli.
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
  entered_descartado_at timestamptz, -- quando entrou na etapa "Descartado" (settings.hubspot_stage_descartado)
  entered_dsq_at timestamptz,        -- quando entrou na etapa "DSQ - BR" (settings.hubspot_stage_dsq)
  synced_at timestamptz not null default now()
);
create index hubspot_leads_descartado_idx on painel.hubspot_leads (entered_descartado_at) where entered_descartado_at is not null;
create index hubspot_leads_dsq_idx on painel.hubspot_leads (entered_dsq_at) where entered_dsq_at is not null;

-- Donos do HubSpot (para ligar o dono do Lead ao SDR pelo e-mail).
create table painel.hubspot_owners (
  owner_id text primary key,
  email text,
  name text,
  synced_at timestamptz not null default now()
);
create index hubspot_owners_email_idx on painel.hubspot_owners (lower(email));
create index hubspot_leads_contact_idx on painel.hubspot_leads (hubspot_contact_id, created_at desc);

alter table painel.hubspot_stages enable row level security;
alter table painel.hubspot_leads enable row level security;
alter table painel.hubspot_owners enable row level security;
grant all on painel.hubspot_stages, painel.hubspot_leads, painel.hubspot_owners to service_role;

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
  ('hubspot_excluded_stages', '["1250901141", "1250901142", "1358962969"]'),
  -- Métricas "Descartados" (card do SDR, pelo dono do Lead) e "DSQ" (só no Time). Decisão de 2026-10-05.
  ('hubspot_stage_descartado', '"1250901141"'),
  ('hubspot_stage_dsq', '"1250901142"')
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

-- Nota interna da Poli com "Finalizado", "DSQ" ou "Descartado" (ou só 0, 1, 2). O worker guarda só a
-- marcação, nunca o texto da nota. Decisão de 2026-10-05.
alter table painel.chat_messages
  add column note_tag text check (note_tag in ('finalizado', 'dsq', 'descartado'));
create index chat_messages_note_tag_idx on painel.chat_messages (lead_id, sent_at desc) where note_tag is not null;

-- Por que o lead está fora de "Aguardando"/"Parados"? Devolve o motivo, ou null se ele conta.
-- 1) Lead mais recente do contato no HubSpot numa etapa excluída (nome da etapa); ou
-- 2) nota interna de descarte, enquanto não existir no HubSpot um Lead do contato criado depois da nota
--    e fora das etapas excluídas.
create function painel.fora_do_funil(p_lead uuid, p_hubspot_contact_id text)
returns text
language sql
stable
set search_path = ''
as $$
  select coalesce(
    painel.hubspot_excluded_stage(p_hubspot_contact_id),
    (select case n.note_tag when 'finalizado' then 'Finalizado (nota)'
                            when 'dsq' then 'DSQ (nota)'
                            else 'Descartado (nota)' end
       from (select m.note_tag, m.sent_at
               from painel.chat_messages m
              where m.lead_id = p_lead and m.note_tag is not null
              order by m.sent_at desc
              limit 1) n
      where not exists (
        select 1
          from painel.hubspot_leads h
         where p_hubspot_contact_id is not null
           and h.hubspot_contact_id = p_hubspot_contact_id
           and h.created_at > n.sent_at
           and h.stage_id not in (
             select jsonb_array_elements_text(s.value) from painel.settings s where s.key = 'hubspot_excluded_stages'
           )
      ))
  );
$$;
revoke execute on function painel.fora_do_funil(uuid, text) from public, anon, authenticated;
grant execute on function painel.fora_do_funil(uuid, text) to service_role;
