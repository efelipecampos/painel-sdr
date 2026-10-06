-- Descartados e DSQ: a nota interna da Poli vem primeiro; sem nota, vale o HubSpot (decisão de 2026-10-05).
-- Descartados (card do SDR e Time): lead com nota "Descartado" no período conta para o SDR dono do chat no
--   momento da nota; lead sem essa nota conta se o Lead do HubSpot entrou em "Descartado" no período, para o
--   dono do Lead. O mesmo lead conta uma vez.
-- DSQ (só Time): lead com nota "DSQ" no período, ou Lead do HubSpot que entrou em "DSQ - BR" no período sem
--   essa nota. Qualquer dono. O mesmo lead conta uma vez.
-- "Finalizado" (suporte, caiu por engano) não conta em nenhum dos dois; só sai de Aguardando/Parados.

-- 1ª resposta por CICLO do lead com cada SDR (decisão de 2026-10-05), e não por atendimento da Poli:
-- conta o primeiro bloco do lead com aquele SDR; um ciclo novo começa depois de nota interna
-- (Descartado/DSQ/Finalizado) ou de entrada em Descartado/DSQ - BR no HubSpot. Lead transferido conta
-- como 1ª resposta do SDR que recebeu. Atendimento novo aberto pela Poli no meio da conversa não reinicia.

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

create or replace function painel.rebuild_leads(p_leads uuid[])
returns void
language plpgsql
set search_path = ''
as $$
begin
  -- 1) Pares bloco do lead → próxima mensagem da equipe (em qualquer atendimento do lead).
  delete from painel.response_events re
  using painel.chats c
  where re.chat_id = c.id and c.lead_id = any (p_leads);

  insert into painel.response_events
    (chat_id, sdr_id, lead_block_started_at, replied_at, is_first_response, seconds_24h, seconds_business)
  with rel as (
    -- Só mensagens que importam para a conversa: do lead ou de uma pessoa da equipe.
    select m.id, m.lead_id, m.chat_id, m.sdr_id, m.sent_at, m.sender = 'lead' as is_lead,
           row_number() over (partition by m.lead_id order by m.sent_at, m.id) as ord
    from painel.chat_messages m
    where m.lead_id = any (p_leads) and (m.sender = 'lead' or m.by_human)
  ),
  marked as (
    select rel.*,
           lag(is_lead) over (partition by lead_id order by ord) as prev_is_lead,
           min(case when not is_lead then ord end)
             over (partition by lead_id order by ord rows between 1 following and unbounded following) as reply_ord
    from rel
  ),
  blocks as (
    select * from marked where is_lead and prev_is_lead is distinct from true
  ),
  resets as (
    -- Momentos em que o ciclo do lead recomeça: nota de descarte/finalizado ou entrada em
    -- Descartado / DSQ - BR no HubSpot.
    select m.lead_id, m.sent_at as at
    from painel.chat_messages m
    where m.lead_id = any (p_leads) and m.note_tag is not null
    union all
    select l.id, x.at
    from painel.leads l
    join painel.hubspot_leads h on h.hubspot_contact_id = l.hubspot_contact_id
    cross join lateral (values (h.entered_descartado_at), (h.entered_dsq_at)) as x(at)
    where l.id = any (p_leads) and x.at is not null
  )
  select b.chat_id,
         b.sdr_id,
         b.sent_at,
         r.sent_at,
         -- 1ª resposta: primeiro bloco do lead com este SDR no ciclo atual (decisão de 2026-10-05).
         not exists (
           select 1 from blocks b2
           where b2.lead_id = b.lead_id
             and b2.sdr_id = b.sdr_id
             and b2.ord < b.ord
             and b2.sent_at > coalesce((select max(rs.at) from resets rs
                                         where rs.lead_id = b.lead_id and rs.at < b.sent_at), '-infinity'::timestamptz)
         ),
         round(extract(epoch from r.sent_at - b.sent_at))::integer,
         painel.business_seconds(b.sent_at, r.sent_at)
  from blocks b
  join rel r on r.lead_id = b.lead_id and r.ord = b.reply_ord
  where b.sdr_id is not null
  on conflict (chat_id, lead_block_started_at) do nothing;

  -- 2) Histórico de donos de cada chat (ilhas de sdr_id consecutivos).
  delete from painel.chat_owner_history h
  using painel.chats c
  where h.chat_id = c.id and c.lead_id = any (p_leads);

  insert into painel.chat_owner_history (chat_id, sdr_id, from_at, to_at)
  with m as (
    select chat_id, sdr_id, sent_at,
           lag(sdr_id) over (partition by chat_id order by sent_at, id) as prev_sdr,
           row_number() over (partition by chat_id order by sent_at, id) as rn
    from painel.chat_messages
    where lead_id = any (p_leads) and sdr_id is not null
  ),
  starts as (
    select chat_id, sdr_id, sent_at from m where rn = 1 or sdr_id is distinct from prev_sdr
  )
  select chat_id, sdr_id, sent_at, lead(sent_at) over (partition by chat_id order by sent_at)
  from starts;

  -- 3) Estado de cada chat.
  with agg as (
    select m.chat_id,
           min(m.sent_at) as opened_at,
           max(m.sent_at) as last_any_at,
           max(m.sent_at) filter (where m.sender = 'lead' or m.by_human) as last_activity_at,
           (array_agg(m.sdr_id order by m.sent_at desc, m.id desc) filter (where m.sdr_id is not null))[1] as sdr_id,
           (array_agg(m.sent_at order by m.sent_at desc, m.id desc) filter (where m.sender <> 'system'))[1] as last_message_at,
           (array_agg(m.sender::text order by m.sent_at desc, m.id desc) filter (where m.sender <> 'system'))[1] as last_message_from,
           (array_agg(m.attendance_type order by m.sent_at, m.id) filter (where m.attendance_type is not null))[1] as attendance_type,
           (array_agg(case when m.sender = 'lead' then 'lead' else 'poli' end order by m.sent_at, m.id)
              filter (where m.sender <> 'system'))[1] as initiated_by,
           (array_agg(m.attendance_status order by m.sent_at desc, m.id desc) filter (where m.attendance_status is not null))[1] as poli_status,
           min(m.sent_at) filter (where m.system_type = 'ATTENDANCE_CLOSED' or m.attendance_status = 'CLOSED') as closed_evt_at,
           (array_agg(m.closed_reason order by m.sent_at, m.id)
              filter (where m.closed_reason is not null
                      and (m.system_type = 'ATTENDANCE_CLOSED' or m.attendance_status = 'CLOSED')))[1] as closed_evt_reason
    from painel.chat_messages m
    join painel.chats c on c.id = m.chat_id
    where c.lead_id = any (p_leads)
    group by m.chat_id
  ),
  st as (
    select a.*,
           (select min(m2.sent_at)
              from painel.chat_messages m2
             where m2.lead_id = c.lead_id
               and m2.chat_id <> c.id
               and (m2.sender = 'lead' or m2.by_human)
               and m2.sent_at > coalesce(a.last_activity_at, a.last_any_at)) as superseded_at
    from agg a
    join painel.chats c on c.id = a.chat_id
  )
  update painel.chats c
     set opened_at = st.opened_at,
         sdr_id = coalesce(st.sdr_id, c.sdr_id),
         last_message_at = st.last_message_at,
         last_message_from = st.last_message_from,
         last_activity_at = st.last_activity_at,
         attendance_type = st.attendance_type,
         initiated_by = st.initiated_by,
         poli_status = st.poli_status,
         status = case when st.closed_evt_at is not null or st.superseded_at is not null
                       then 'closed'::painel.chat_status else 'open'::painel.chat_status end,
         closed_at = coalesce(st.closed_evt_at, st.superseded_at),
         closed_reason = case
                           when st.closed_evt_at is not null then st.closed_evt_reason
                           when st.superseded_at is not null then 'SUBSTITUIDO'
                         end
    from st
   where c.id = st.chat_id;

  -- 4) Quem iniciou, por lead: primeira mensagem (sem eventos de sistema) do primeiro atendimento.
  update painel.leads l
     set initiated_by = x.v
    from (
      select distinct on (m.lead_id) m.lead_id, case when m.sender = 'lead' then 'lead' else 'poli' end as v
      from painel.chat_messages m
      where m.lead_id = any (p_leads) and m.sender <> 'system'
      order by m.lead_id, m.sent_at, m.id
    ) x
   where l.id = x.lead_id;

  -- 5) Desde quando o lead espera resposta neste chat (null = não está esperando).
  --    Início = primeira mensagem do lead depois da última mensagem da equipe para ele, em qualquer atendimento.
  update painel.chats c
     set waiting_since = case when c.status = 'open' then w.since end
    from (
      select c2.id,
             (select min(m.sent_at)
                from painel.chat_messages m
               where m.chat_id = c2.id
                 and m.sender = 'lead'
                 and m.sent_at > coalesce((select max(h.sent_at)
                                             from painel.chat_messages h
                                            where h.lead_id = c2.lead_id and h.by_human), '-infinity'::timestamptz)) as since
      from painel.chats c2
      where c2.lead_id = any (p_leads)
    ) w
   where c.id = w.id;
end;
$$;
