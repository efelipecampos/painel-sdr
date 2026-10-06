-- Métricas da automação de disparo (app token / n8n), só na linha do Time (decisão de 2026-10-06):
-- cadastro = criação do Lead no HubSpot no "[New] Pipeline SDR"; disparo = 1º template do app token
-- (template sem autor) para o mesmo contato, em até 24 h depois do cadastro.

insert into painel.settings (key, value) values ('hubspot_pipeline_sdr', '"841793591"')
on conflict (key) do nothing;

create function painel.disparo_app_token(p_from timestamptz, p_to timestamptz)
returns table (mediana_s integer, cadastros integer, sem_disparo integer)
language sql
stable
set search_path = ''
as $$
  with cad as (
    select h.hubspot_contact_id, h.created_at, h.stage_id
    from painel.hubspot_leads h
    where h.pipeline_id = (select s.value #>> '{}' from painel.settings s where s.key = 'hubspot_pipeline_sdr')
      and h.created_at >= p_from and h.created_at < p_to
  ),
  d as (
    select c.*,
           (select min(m.sent_at)
              from painel.leads l
              join painel.chat_messages m on m.lead_id = l.id
             where l.hubspot_contact_id = c.hubspot_contact_id
               and m.sender = 'template' and not m.by_human
               and m.sent_at >= c.created_at and m.sent_at < c.created_at + interval '24 hours') as disparo_at
    from cad c
  )
  select round(percentile_cont(0.5) within group (order by extract(epoch from d.disparo_at - d.created_at))
                 filter (where d.disparo_at is not null))::integer,
         count(*)::integer,
         count(*) filter (
           where d.stage_id is distinct from (select s.value #>> '{}' from painel.settings s where s.key = 'hubspot_stage_dsq')
             and d.created_at < now() - interval '30 minutes'
             and (d.disparo_at is null or d.disparo_at > d.created_at + interval '30 minutes')
         )::integer
  from d;
$$;
revoke execute on function painel.disparo_app_token(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function painel.disparo_app_token(timestamptz, timestamptz) to service_role;

-- team_metrics ganha 3 colunas (muda o tipo de retorno: precisa recriar).
drop function painel.team_metrics(timestamptz, timestamptz, boolean);
create function painel.team_metrics(p_from timestamptz, p_to timestamptz, p_business_only boolean default null)
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
  dsq integer,               -- Leads que entraram em "DSQ - BR" no período (qualquer dono)
  disparo_mediana_s integer, -- mediana do tempo cadastro (Lead no HubSpot) → 1º template do app token
  cadastros integer,         -- Leads criados no [New] Pipeline SDR no período
  cadastros_sem_disparo integer -- desses, fora de DSQ e sem template do app token em até 30 min
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
         painel.dsq_count(p_from, p_to),
         disp.mediana_s, disp.cadastros, disp.sem_disparo
  from painel.disparo_app_token(p_from, p_to) disp,
  (
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

revoke execute on function painel.team_metrics(timestamptz, timestamptz, boolean) from public, anon;
grant execute on function painel.team_metrics(timestamptz, timestamptz, boolean) to authenticated, service_role;
