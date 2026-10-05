-- Ajustes da Fase 4 depois da conferência com dados reais (2026-10-05):
-- 1) Medianas de 1ª resposta e de resposta entram no período pelo momento em que o LEAD escreveu
--    (início do bloco), não pelo momento da resposta. Lead que escreveu no período e ainda não foi
--    respondido fica fora da mediana (aparece em "Aguardando").
-- 2) Com "Só horário comercial" ligado, só entram nas medianas os blocos em que o lead escreveu dentro
--    do expediente (conforme as configurações, sem feriados). O tempo é sempre o real (relógio):
--    o que importa é se quem escreveu no horário de trabalho foi atendido rápido. Desligado: entra tudo.
-- 3) Horário comercial: segunda a sexta, 08:20–17:45 (decisão do Felipe, 2026-10-05).
-- 4) Os contadores ao lado das medianas passam a ser LEADS distintos (não respostas):
--    leads_primeira_resposta e leads_resposta.
-- 5) Lead fora do funil sai de "Aguardando" e "Parados": Lead mais recente no HubSpot numa etapa de
--    settings.hubspot_excluded_stages, ou nota interna de descarte (Finalizado/DSQ/Descartado). Na tabela do
--    SDR aparece como "fora_do_funil", com o motivo. (tabelas e funções em 20261005140000_hubspot_e_notas.sql)
-- 6) A escolha vem da configuração metrics_business_only; o parâmetro p_business_only, se informado,
--    sobrepõe a configuração (útil para comparar).
-- 7) sdr_chats: nova situação "encerrado_sem_resposta" e as mesmas regras de mediana (abaixo).

update painel.business_hours
   set start_time = '08:20', end_time = '17:45'
 where weekday between 1 and 5;

-- "Só horário comercial" vira uma opção das Configurações (não é mais botão na tela principal).
-- Marcada: medianas só com leads que escreveram no expediente. Desmarcada: qualquer mensagem do lead.
insert into painel.settings (key, value) values ('metrics_business_only', 'true')
on conflict (key) do nothing;

create index response_events_sdr_block_idx on painel.response_events (sdr_id, lead_block_started_at);

-- Um instante está dentro do horário comercial configurado?
create function painel.is_business_time(p_at timestamptz)
returns boolean
language sql
stable
set search_path = ''
as $$
  select painel.business_seconds(p_at, p_at + interval '1 second') > 0;
$$;
revoke execute on function painel.is_business_time(timestamptz) from public, anon;
grant execute on function painel.is_business_time(timestamptz) to authenticated, service_role;

drop function painel.sdr_metrics(timestamptz, timestamptz, boolean);
create function painel.sdr_metrics(p_from timestamptz, p_to timestamptz, p_business_only boolean default null)
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
  parados integer
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
         coalesce(wait.stale, 0)::integer
  from team
  left join msg on msg.sdr_id = team.id
  left join resp on resp.sdr_id = team.id
  left join wait on wait.sdr_id = team.id
  order by team.name;
end;
$$;

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
  parados integer
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
         w.n::integer, w.stale::integer
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

-- sdr_chats: nova situação "encerrado_sem_resposta" — chat fechado (encerrado, transferido ou substituído)
-- em que a última mensagem do lead ficou sem resposta da equipe. Antes aparecia como "respondido".
drop function painel.sdr_chats(uuid, timestamptz, timestamptz, boolean, text, text, integer, integer);
create function painel.sdr_chats(
  p_sdr uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_business_only boolean default null,
  p_filter text default 'all',
  p_search text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  chat_id uuid,
  poli_contact_uuid text,
  lead_name text,
  phone_masked text,
  situacao text,              -- aguardando | respondido | lead_nao_respondeu | encerrado_sem_resposta | fora_do_funil
  waiting_since timestamptz,
  parado boolean,
  templates integer,
  primeira_resposta_s integer,
  resposta_s integer,
  msgs_lead integer,
  msgs_equipe integer,
  last_message_at timestamptz,
  last_message_from text,     -- lead | sdr | template | bot
  origem text,                -- lead | poli (quem iniciou a relação com o lead)
  fora_motivo text,           -- por que saiu de "Aguardando": etapa do HubSpot (Descartado, DSQ - BR, Qualificado) ou nota ("Descartado (nota)"...)
  total bigint                -- total de linhas do filtro, para a paginação
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
  v_search text := nullif(trim(coalesce(p_search, '')), '');
  v_digits text := nullif(regexp_replace(coalesce(p_search, ''), '\D', '', 'g'), '');
begin
  if not painel.can_read_metrics() then
    raise exception 'acesso negado' using errcode = '42501';
  end if;

  return query
  with base as (
    select c.id, c.lead_id, c.status, c.waiting_since, c.last_message_at, c.last_message_from,
           l.poli_contact_uuid, l.name as lead_name, l.phone_e164, l.initiated_by,
           painel.fora_do_funil(l.id, l.hubspot_contact_id) as fora_motivo
    from painel.chats c
    join painel.leads l on l.id = c.lead_id
    where c.sdr_id = p_sdr
      and exists (select 1 from painel.chat_messages m
                   where m.chat_id = c.id and m.sent_at >= p_from and m.sent_at < p_to)
      and (v_search is null
           or l.name ilike '%' || v_search || '%'
           or (v_digits is not null and regexp_replace(coalesce(l.phone_e164, ''), '\D', '', 'g') like '%' || v_digits || '%'))
  ),
  stats as (
    select b.id,
           count(*) filter (where m.sender = 'template') as templates,
           count(*) filter (where m.sender = 'lead') as msgs_lead,
           count(*) filter (where m.by_human) as msgs_equipe,
           max(m.sent_at) filter (where m.sender = 'lead') as last_lead_at
    from base b
    join painel.chat_messages m on m.chat_id = b.id
    group by b.id
  ),
  last_team as (
    -- última mensagem da equipe para o lead, em qualquer atendimento
    select b.id, (select max(h.sent_at) from painel.chat_messages h where h.lead_id = b.lead_id and h.by_human) as at
    from base b
  ),
  resp as (
    select r.chat_id,
           min(r.seconds_24h) filter (where r.is_first_response) as first_s,
           percentile_cont(0.5) within group (order by r.seconds_24h) as med_s
    from painel.response_events r
    where r.chat_id in (select base.id from base)
      and (not v_biz or painel.is_business_time(r.lead_block_started_at))
    group by r.chat_id
  ),
  linhas as (
    select b.*,
           case when b.status = 'open' and b.waiting_since is not null and b.fora_motivo is not null then 'fora_do_funil'
                when b.status = 'open' and b.waiting_since is not null then 'aguardando'
                when coalesce(st.msgs_lead, 0) = 0 then 'lead_nao_respondeu'
                when st.last_lead_at > coalesce(lt.at, '-infinity'::timestamptz) then 'encerrado_sem_resposta'
                else 'respondido' end as situacao,
           st.templates, st.msgs_lead, st.msgs_equipe, resp.first_s, resp.med_s
    from base b
    left join stats st on st.id = b.id
    left join resp on resp.chat_id = b.id
    left join last_team lt on lt.id = b.id
  )
  select linhas.id,
         linhas.poli_contact_uuid,
         linhas.lead_name,
         case when linhas.phone_e164 is null then null else
           (with d as (select case when length(x) >= 12 and left(x, 2) = '55' then substr(x, 3) else x end as n
                        from (select regexp_replace(linhas.phone_e164, '\D', '', 'g') as x) q)
            select case when length(d.n) >= 6
                        then '(' || left(d.n, 2) || ') ' || substr(d.n, 3, 1) || '••••-' || right(d.n, 4)
                        else '••••' end
            from d)
         end,
         linhas.situacao,
         case when linhas.situacao = 'aguardando' then linhas.waiting_since end,
         linhas.situacao = 'aguardando'
           and (case when v_stale_biz then painel.business_seconds(linhas.waiting_since, now())
                     else extract(epoch from now() - linhas.waiting_since) end) > v_stale_min * 60,
         coalesce(linhas.templates, 0)::integer,
         linhas.first_s::integer,
         round(linhas.med_s)::integer,
         coalesce(linhas.msgs_lead, 0)::integer,
         coalesce(linhas.msgs_equipe, 0)::integer,
         linhas.last_message_at,
         linhas.last_message_from,
         linhas.initiated_by,
         linhas.fora_motivo,
         count(*) over ()
  from linhas
  where coalesce(p_filter, 'all') = 'all'
     or (p_filter = 'waiting' and linhas.situacao = 'aguardando')
     or (p_filter = 'noreply' and linhas.situacao = 'lead_nao_respondeu')
  order by (linhas.situacao = 'aguardando') desc, linhas.waiting_since asc nulls last, linhas.last_message_at desc nulls last
  limit least(greatest(coalesce(p_limit, 50), 1), 200)
  offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

revoke execute on function painel.sdr_metrics(timestamptz, timestamptz, boolean) from public, anon;
revoke execute on function painel.team_metrics(timestamptz, timestamptz, boolean) from public, anon;
grant execute on function painel.sdr_metrics(timestamptz, timestamptz, boolean) to authenticated, service_role;
grant execute on function painel.team_metrics(timestamptz, timestamptz, boolean) to authenticated, service_role;
revoke execute on function painel.sdr_chats(uuid, timestamptz, timestamptz, boolean, text, text, integer, integer) from public, anon;
grant execute on function painel.sdr_chats(uuid, timestamptz, timestamptz, boolean, text, text, integer, integer) to authenticated, service_role;
