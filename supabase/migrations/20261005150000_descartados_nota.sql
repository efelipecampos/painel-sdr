-- Descartados e DSQ: a nota interna da Poli vem primeiro; sem nota, vale o HubSpot (decisão de 2026-10-05).
-- Descartados (card do SDR e Time): lead com nota "Descartado" no período conta para o SDR dono do chat no
--   momento da nota; lead sem essa nota conta se o Lead do HubSpot entrou em "Descartado" no período, para o
--   dono do Lead. O mesmo lead conta uma vez.
-- DSQ (só Time): lead com nota "DSQ" no período, ou Lead do HubSpot que entrou em "DSQ - BR" no período sem
--   essa nota. Qualquer dono. O mesmo lead conta uma vez.
-- "Finalizado" (suporte, caiu por engano) não conta em nenhum dos dois; só sai de Aguardando/Parados.

-- Cada lead descartado no período, com o SDR a quem o descarte é atribuído.
create function painel.descartes(p_from timestamptz, p_to timestamptz)
returns table (sdr_id uuid, lead_key text, origem text)
language sql
stable
set search_path = ''
as $$
  with nota as (
    select distinct on (m.lead_id) m.lead_id, m.sdr_id
    from painel.chat_messages m
    where m.note_tag = 'descartado' and m.sent_at >= p_from and m.sent_at < p_to
    order by m.lead_id, m.sent_at desc
  ),
  hs as (
    select sd.id as sdr_id, h.hubspot_contact_id, h.hubspot_lead_id
    from painel.hubspot_leads h
    join painel.hubspot_owners o on o.owner_id = h.owner_id
    join painel.sdrs sd on lower(sd.poli_email) = lower(o.email)
    where h.entered_descartado_at >= p_from and h.entered_descartado_at < p_to
  )
  select n.sdr_id, 'lead:' || n.lead_id::text, 'nota' from nota n
  union
  select hs.sdr_id,
         coalesce('lead:' || l.id::text, 'hs:' || coalesce(hs.hubspot_contact_id, hs.hubspot_lead_id)),
         'hubspot'
  from hs
  left join painel.leads l on l.hubspot_contact_id = hs.hubspot_contact_id
  where not exists (select 1 from nota n where n.lead_id = l.id);
$$;
revoke execute on function painel.descartes(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function painel.descartes(timestamptz, timestamptz) to service_role;

-- Leads DSQ no período (Time).
create function painel.dsq_count(p_from timestamptz, p_to timestamptz)
returns integer
language sql
stable
set search_path = ''
as $$
  with nota as (
    select distinct m.lead_id
    from painel.chat_messages m
    where m.note_tag = 'dsq' and m.sent_at >= p_from and m.sent_at < p_to
  )
  select count(distinct k)::integer from (
    select 'lead:' || n.lead_id::text as k from nota n
    union
    select coalesce('lead:' || l.id::text, 'hs:' || coalesce(h.hubspot_contact_id, h.hubspot_lead_id))
    from painel.hubspot_leads h
    left join painel.leads l on l.hubspot_contact_id = h.hubspot_contact_id
    where h.entered_dsq_at >= p_from and h.entered_dsq_at < p_to
      and not exists (select 1 from nota n where n.lead_id = l.id)
  ) x;
$$;
revoke execute on function painel.dsq_count(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function painel.dsq_count(timestamptz, timestamptz) to service_role;

create or replace function painel.sdr_metrics(p_from timestamptz, p_to timestamptz, p_business_only boolean default null)
returns table (
  sdr_id uuid,
  name text,
  leads_abordados integer,
  templates_enviados integer,
  leads_responderam integer,
  primeira_resposta_s integer,
  leads_primeira_resposta integer, -- leads distintos que entraram na mediana da 1ª resposta
  resposta_s integer,
  leads_resposta integer,          -- leads distintos que entraram na mediana de resposta
  aguardando integer,
  parados integer,
  descartados integer        -- Leads do HubSpot que entraram em "Descartado" no período, pelo dono do Lead
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_biz boolean := coalesce(p_business_only,
                            (select (s.value #>> '{}')::boolean from painel.settings s where s.key = 'metrics_business_only'),
                            true);
  v_stale_min integer := coalesce((select (s.value #>> '{}')::integer from painel.settings s where s.key = 'stale_minutes'), 30);
  v_stale_biz boolean := coalesce((select (s.value #>> '{}')::boolean from painel.settings s where s.key = 'stale_business_only'), false);
begin
  if not painel.can_read_metrics() then
    raise exception 'acesso negado' using errcode = '42501';
  end if;

  return query
  with team as (
    select t.id, t.name from painel.sdrs t where t.role = 'sdr' and t.active
  ),
  msg as (
    select m.sdr_id,
           count(distinct m.lead_id) filter (where m.sender = 'template') as abordados,
           count(*) filter (where m.sender = 'template') as templates,
           count(distinct m.lead_id) filter (where m.sender = 'lead') as responderam
    from painel.chat_messages m
    where m.sent_at >= p_from and m.sent_at < p_to and m.sdr_id in (select team.id from team)
    group by m.sdr_id
  ),
  resp as (
    select r.sdr_id,
           percentile_cont(0.5) within group (order by r.seconds_24h)
             filter (where r.is_first_response) as p_first,
           count(distinct c.lead_id) filter (where r.is_first_response) as n_first,
           percentile_cont(0.5) within group (order by r.seconds_24h) as p_all,
           count(distinct c.lead_id) as n_all
    from painel.response_events r
    join painel.chats c on c.id = r.chat_id
    where r.lead_block_started_at >= p_from and r.lead_block_started_at < p_to
      and (not v_biz or painel.is_business_time(r.lead_block_started_at)) and r.sdr_id in (select team.id from team)
    group by r.sdr_id
  ),
  wait as (
    select c.sdr_id,
           count(*) as n,
           count(*) filter (where case when v_stale_biz then painel.business_seconds(c.waiting_since, now())
                                       else extract(epoch from now() - c.waiting_since) end > v_stale_min * 60) as stale
    from painel.chats c
    join painel.leads l on l.id = c.lead_id
    where c.status = 'open' and c.waiting_since is not null and c.sdr_id in (select team.id from team)
      and painel.fora_do_funil(l.id, l.hubspot_contact_id) is null  -- descartado/qualificado no HubSpot ou por nota não conta
    group by c.sdr_id
  )
  , disc as (
    select d.sdr_id, count(distinct d.lead_key) as n
    from painel.descartes(p_from, p_to) d
    where d.sdr_id in (select team.id from team)
    group by d.sdr_id
  )
  select team.id,
         team.name,
         coalesce(msg.abordados, 0)::integer,
         coalesce(msg.templates, 0)::integer,
         coalesce(msg.responderam, 0)::integer,
         round(resp.p_first)::integer,
         coalesce(resp.n_first, 0)::integer,
         round(resp.p_all)::integer,
         coalesce(resp.n_all, 0)::integer,
         coalesce(wait.n, 0)::integer,
         coalesce(wait.stale, 0)::integer,
         coalesce(disc.n, 0)::integer
  from team
  left join msg on msg.sdr_id = team.id
  left join resp on resp.sdr_id = team.id
  left join wait on wait.sdr_id = team.id
  left join disc on disc.sdr_id = team.id
  order by team.name;
end;
$$;

create or replace function painel.team_metrics(p_from timestamptz, p_to timestamptz, p_business_only boolean default null)
returns table (
  sdrs integer,
  leads_abordados integer,
  templates_enviados integer,
  leads_responderam integer,
  primeira_resposta_s integer,
  leads_primeira_resposta integer, -- leads distintos que entraram na mediana da 1ª resposta
  resposta_s integer,
  leads_resposta integer,          -- leads distintos que entraram na mediana de resposta
  aguardando integer,
  parados integer,
  descartados integer,       -- Leads que entraram em "Descartado" no período (donos SDR)
  dsq integer                -- Leads que entraram em "DSQ - BR" no período (qualquer dono)
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_biz boolean := coalesce(p_business_only,
                            (select (s.value #>> '{}')::boolean from painel.settings s where s.key = 'metrics_business_only'),
                            true);
  v_stale_min integer := coalesce((select (s.value #>> '{}')::integer from painel.settings s where s.key = 'stale_minutes'), 30);
  v_stale_biz boolean := coalesce((select (s.value #>> '{}')::boolean from painel.settings s where s.key = 'stale_business_only'), false);
begin
  if not painel.can_read_metrics() then
    raise exception 'acesso negado' using errcode = '42501';
  end if;

  return query
  with team as (
    select t.id from painel.sdrs t where t.role = 'sdr' and t.active
  )
  select (select count(*) from team)::integer,
         m.abordados::integer, m.templates::integer, m.responderam::integer,
         round(r.p_first)::integer, r.n_first::integer, round(r.p_all)::integer, r.n_all::integer,
         w.n::integer, w.stale::integer,
         (select count(distinct d.lead_key) from painel.descartes(p_from, p_to) d
           where d.sdr_id in (select team.id from team))::integer,
         painel.dsq_count(p_from, p_to)
  from (
    select count(distinct x.lead_id) filter (where x.sender = 'template') as abordados,
           count(*) filter (where x.sender = 'template') as templates,
           count(distinct x.lead_id) filter (where x.sender = 'lead') as responderam
    from painel.chat_messages x
    where x.sent_at >= p_from and x.sent_at < p_to and x.sdr_id in (select team.id from team)
  ) m,
  (
    select percentile_cont(0.5) within group (order by y.seconds_24h)
             filter (where y.is_first_response) as p_first,
           count(distinct yc.lead_id) filter (where y.is_first_response) as n_first,
           percentile_cont(0.5) within group (order by y.seconds_24h) as p_all,
           count(distinct yc.lead_id) as n_all
    from painel.response_events y
    join painel.chats yc on yc.id = y.chat_id
    where y.lead_block_started_at >= p_from and y.lead_block_started_at < p_to
      and (not v_biz or painel.is_business_time(y.lead_block_started_at)) and y.sdr_id in (select team.id from team)
  ) r,
  (
    select count(*) as n,
           count(*) filter (where case when v_stale_biz then painel.business_seconds(c.waiting_since, now())
                                       else extract(epoch from now() - c.waiting_since) end > v_stale_min * 60) as stale
    from painel.chats c
    join painel.leads l on l.id = c.lead_id
    where c.status = 'open' and c.waiting_since is not null and c.sdr_id in (select team.id from team)
      and painel.fora_do_funil(l.id, l.hubspot_contact_id) is null  -- descartado/qualificado no HubSpot ou por nota não conta
  ) w;
end;
$$;
