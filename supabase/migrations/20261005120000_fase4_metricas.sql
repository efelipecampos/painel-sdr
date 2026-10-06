-- Fase 4: métricas no banco (docs/spec.md, seção 2; decisões de 2026-10-05 em docs/COMECE-AQUI.md).
-- Funções que a tela chama: painel.sdr_metrics, painel.team_metrics, painel.sdr_chats.
-- Todas exigem usuário logado e ativo (painel.is_active_user) e rodam como security definer.

-- Quem iniciou a relação com o lead: primeira mensagem do primeiro atendimento dele.
alter table painel.leads add column initiated_by text check (initiated_by in ('lead', 'poli'));

-- Desde quando o lead espera resposta no chat (preenchido pelo worker em rebuild_leads).
alter table painel.chats add column waiting_since timestamptz;
create index chats_waiting_idx on painel.chats (sdr_id) where waiting_since is not null;

-- rebuild_leads ganha os passos 4 (leads.initiated_by) e 5 (chats.waiting_since).
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
  first_lead_msg as (
    select distinct on (m.chat_id) m.id
    from painel.chat_messages m
    where m.lead_id = any (p_leads) and m.sender = 'lead'
    order by m.chat_id, m.sent_at, m.id
  )
  select b.chat_id,
         b.sdr_id,
         b.sent_at,
         r.sent_at,
         exists (select 1 from first_lead_msg f where f.id = b.id),
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

-- Quem pode chamar as funções da tela: usuário logado e ativo, ou o servidor (service_role).
create function painel.can_read_metrics()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select painel.is_active_user()
      or coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '') = 'service_role';
$$;
revoke execute on function painel.can_read_metrics() from public, anon;
grant execute on function painel.can_read_metrics() to authenticated, service_role;

-- Cards por SDR. Período semiaberto [p_from, p_to). Medianas em segundos (corridos ou em horário comercial).
-- Aguardando e parados são o estado de agora (não dependem do período).
create function painel.sdr_metrics(p_from timestamptz, p_to timestamptz, p_business_only boolean default false)
returns table (
  sdr_id uuid,
  name text,
  leads_abordados integer,
  templates_enviados integer,
  leads_responderam integer,
  primeira_resposta_s integer,
  primeiras_respostas integer,
  resposta_s integer,
  respostas integer,
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
           percentile_cont(0.5) within group (order by case when p_business_only then r.seconds_business else r.seconds_24h end)
             filter (where r.is_first_response) as p_first,
           count(*) filter (where r.is_first_response) as n_first,
           percentile_cont(0.5) within group (order by case when p_business_only then r.seconds_business else r.seconds_24h end) as p_all,
           count(*) as n_all
    from painel.response_events r
    where r.replied_at >= p_from and r.replied_at < p_to and r.sdr_id in (select team.id from team)
    group by r.sdr_id
  ),
  wait as (
    select c.sdr_id,
           count(*) as n,
           count(*) filter (where case when v_stale_biz then painel.business_seconds(c.waiting_since, now())
                                       else extract(epoch from now() - c.waiting_since) end > v_stale_min * 60) as stale
    from painel.chats c
    where c.status = 'open' and c.waiting_since is not null and c.sdr_id in (select team.id from team)
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

-- Linha "Time": os mesmos números somando todos os SDRs. As medianas são calculadas sobre todas as
-- respostas do time (não é a média das medianas).
create function painel.team_metrics(p_from timestamptz, p_to timestamptz, p_business_only boolean default false)
returns table (
  sdrs integer,
  leads_abordados integer,
  templates_enviados integer,
  leads_responderam integer,
  primeira_resposta_s integer,
  primeiras_respostas integer,
  resposta_s integer,
  respostas integer,
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
    select percentile_cont(0.5) within group (order by case when p_business_only then y.seconds_business else y.seconds_24h end)
             filter (where y.is_first_response) as p_first,
           count(*) filter (where y.is_first_response) as n_first,
           percentile_cont(0.5) within group (order by case when p_business_only then y.seconds_business else y.seconds_24h end) as p_all,
           count(*) as n_all
    from painel.response_events y
    where y.replied_at >= p_from and y.replied_at < p_to and y.sdr_id in (select team.id from team)
  ) r,
  (
    select count(*) as n,
           count(*) filter (where case when v_stale_biz then painel.business_seconds(c.waiting_since, now())
                                       else extract(epoch from now() - c.waiting_since) end > v_stale_min * 60) as stale
    from painel.chats c
    where c.status = 'open' and c.waiting_since is not null and c.sdr_id in (select team.id from team)
  ) w;
end;
$$;

-- Tabela da tela do SDR: chats em que ele é o dono e que tiveram mensagem no período.
-- p_filter: 'all' | 'waiting' (aguardando resposta) | 'noreply' (lead não respondeu).
-- p_search: parte do nome do lead ou do telefone. Telefone sai mascarado: (62) 9••••-1187.
-- Contagens, 1ª resposta e mediana de resposta são do chat inteiro.
create function painel.sdr_chats(
  p_sdr uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_business_only boolean default false,
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
  situacao text,              -- aguardando | respondido | lead_nao_respondeu
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
  total bigint                -- total de linhas do filtro, para a paginação
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
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
           l.poli_contact_uuid, l.name as lead_name, l.phone_e164, l.initiated_by
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
           count(*) filter (where m.by_human) as msgs_equipe
    from base b
    join painel.chat_messages m on m.chat_id = b.id
    group by b.id
  ),
  resp as (
    select r.chat_id,
           min(case when p_business_only then r.seconds_business else r.seconds_24h end) filter (where r.is_first_response) as first_s,
           percentile_cont(0.5) within group (order by case when p_business_only then r.seconds_business else r.seconds_24h end) as med_s
    from painel.response_events r
    where r.chat_id in (select base.id from base)
    group by r.chat_id
  ),
  linhas as (
    select b.*,
           case when b.status = 'open' and b.waiting_since is not null then 'aguardando'
                when coalesce(st.msgs_lead, 0) = 0 then 'lead_nao_respondeu'
                else 'respondido' end as situacao,
           st.templates, st.msgs_lead, st.msgs_equipe, resp.first_s, resp.med_s
    from base b
    left join stats st on st.id = b.id
    left join resp on resp.chat_id = b.id
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
revoke execute on function painel.sdr_chats(uuid, timestamptz, timestamptz, boolean, text, text, integer, integer) from public, anon;
grant execute on function painel.sdr_metrics(timestamptz, timestamptz, boolean) to authenticated, service_role;
grant execute on function painel.team_metrics(timestamptz, timestamptz, boolean) to authenticated, service_role;
grant execute on function painel.sdr_chats(uuid, timestamptz, timestamptz, boolean, text, text, integer, integer) to authenticated, service_role;
