-- sdr_chats: nova situação "encerrado_sem_resposta" — chat fechado (encerrado, transferido ou substituído)
-- em que a última mensagem do lead ficou sem resposta da equipe. Antes aparecia como "respondido".
create or replace function painel.sdr_chats(
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
  situacao text,              -- aguardando | respondido | lead_nao_respondeu | encerrado_sem_resposta
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
