-- Transferência de atendimento entre SDRs (decisões do Felipe, 2026-10-08).
-- 1) A transferência (evento ATTENDANCE_REDIRECTED no atendimento novo) encerra o atendimento anterior do lead.
-- 2) Mensagens do lead ainda sem resposta na hora da transferência passam para quem recebeu: a espera
--    ("Aguardando", "Parados") vai para o novo dono, contando desde a mensagem do lead, e a resposta conta
--    na 1ª resposta e no tempo de resposta de quem recebeu. O que o SDR anterior fez continua com ele.
--    Para closer: sai dos números do SDR. Para a fila (sem atendente): fica com quem transferiu.
-- 3) A lista do SDR não mostra lead que só passou por ele em evento de sistema (nota de descarte continua contando).
-- Vale para o passado: depois de aplicar, rodar `npm run rebuild-all -w @painel/worker`.

-- Dono segundo a Poli (o que o worker grava); sdr_id passa a ser o dono efetivo, recalculado em rebuild_leads.
alter table painel.chat_messages add column poli_sdr_id uuid references painel.sdrs;
update painel.chat_messages set poli_sdr_id = sdr_id where sdr_id is not null;
create index chat_messages_redirect_idx on painel.chat_messages (lead_id, sent_at)
  where system_type = 'ATTENDANCE_REDIRECTED';

create or replace function painel.rebuild_leads(p_leads uuid[])
returns void
language plpgsql
set search_path = ''
as $$
begin
  -- 0) Mensagens de robôs da Poli (sdrs.is_bot: Lia, Poliana...) são automação: não são resposta humana.
  update painel.chat_messages m
     set sender = case when m.sender = 'sdr' then 'bot'::painel.sender_type else m.sender end,
         by_human = false
    from painel.sdrs b
   where m.lead_id = any (p_leads)
     and b.is_bot
     and m.author_poli_uuid = b.poli_attendant_uuid
     and (m.by_human or m.sender = 'sdr');

  -- 0b) Transferência (decisão de 2026-10-08): mensagens do lead ainda sem resposta quando o atendimento é
  --     transferido passam para quem recebeu (o último que recebeu antes da próxima resposta da equipe).
  --     poli_sdr_id guarda o dono segundo a Poli; sdr_id é o dono efetivo usado nas métricas.
  --     Transferência para a fila (sem atendente) não move: fica com quem transferiu até alguém assumir.
  update painel.chat_messages m
     set poli_sdr_id = m.sdr_id
   where m.lead_id = any (p_leads) and m.poli_sdr_id is null and m.sdr_id is not null;

  update painel.chat_messages m
     set sdr_id = x.dono
    from (
      select l.id,
             coalesce((select r.poli_sdr_id
                         from painel.chat_messages r
                        where r.lead_id = l.lead_id
                          and r.system_type = 'ATTENDANCE_REDIRECTED'
                          and r.chat_id <> l.chat_id
                          and r.sent_at > l.sent_at
                          and r.poli_sdr_id is not null
                          and not exists (select 1 from painel.chat_messages h
                                           where h.lead_id = l.lead_id and h.by_human
                                             and h.sent_at > l.sent_at and h.sent_at <= r.sent_at)
                        order by r.sent_at desc, r.id desc
                        limit 1),
                      l.poli_sdr_id) as dono
        from painel.chat_messages l
       where l.lead_id = any (p_leads) and l.sender = 'lead'
    ) x
   where m.id = x.id and m.sdr_id is distinct from x.dono;

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
    select chat_id, poli_sdr_id as sdr_id, sent_at,
           lag(poli_sdr_id) over (partition by chat_id order by sent_at, id) as prev_sdr,
           row_number() over (partition by chat_id order by sent_at, id) as rn
    from painel.chat_messages
    where lead_id = any (p_leads) and poli_sdr_id is not null
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
           -- dono do atendimento segundo a Poli (não o efetivo das mensagens movidas por transferência)
           (array_agg(m.poli_sdr_id order by m.sent_at desc, m.id desc) filter (where m.poli_sdr_id is not null))[1] as sdr_id,
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
               -- transferência abre atendimento novo e encerra este (2026-10-08)
               and (m2.sender = 'lead' or m2.by_human or m2.system_type = 'ATTENDANCE_REDIRECTED')
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
  --    Conta a mensagem escrita neste chat ou a que veio para o dono dele por transferência (2026-10-08):
  --    o relógio começa na mensagem do lead, não na transferência.
  update painel.chats c
     set waiting_since = case when c.status = 'open' then w.since end
    from (
      select c2.id,
             (select min(m.sent_at)
                from painel.chat_messages m
               where m.lead_id = c2.lead_id
                 and m.sender = 'lead'
                 and ((m.chat_id = c2.id and m.sdr_id is not distinct from m.poli_sdr_id)
                      or (m.chat_id <> c2.id and m.sdr_id = c2.sdr_id
                          and m.sdr_id is distinct from m.poli_sdr_id and m.sent_at <= c2.opened_at))
                 and m.sent_at > coalesce((select max(h.sent_at)
                                             from painel.chat_messages h
                                            where h.lead_id = c2.lead_id and h.by_human), '-infinity'::timestamptz)) as since
      from painel.chats c2
      where c2.lead_id = any (p_leads)
    ) w
   where c.id = w.id;
end;
$$;

create or replace function painel.sdr_chats(
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
  lead_id uuid,
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
  fora_motivo text,           -- por que saiu de "Aguardando" (etapa do HubSpot ou nota)
  reuniao_status text,        -- agendada | validada | invalidada | noshow | cancelada | null
  reuniao_origem text,        -- hubspot | manual | null
  total bigint                -- total de linhas do filtro, para a paginação
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_scope uuid := painel.escopo_sdr();
  v_biz boolean := coalesce(p_business_only,
                            (select (s.value #>> '{}')::boolean from painel.settings s where s.key = 'metrics_business_only'),
                            true);
  v_stale_min integer := coalesce((select (s.value #>> '{}')::integer from painel.settings s where s.key = 'stale_minutes'), 30);
  v_stale_biz boolean := coalesce((select (s.value #>> '{}')::boolean from painel.settings s where s.key = 'stale_business_only'), false);
  v_search text := nullif(trim(coalesce(p_search, '')), '');
  v_digits text := nullif(regexp_replace(coalesce(p_search, ''), '\D', '', 'g'), '');
begin
  if v_scope is not null and v_scope is distinct from p_sdr then   -- SDR só vê a própria tabela
    raise exception 'acesso negado' using errcode = '42501';
  end if;

  return query
  with base as (
    select l.id, l.poli_contact_uuid, l.name as lead_name, l.phone_e164, l.initiated_by,
           painel.fora_do_funil(l.id, l.hubspot_contact_id) as fora_motivo,
           (painel.reuniao_do_lead(l.id, l.hubspot_contact_id)).status as reuniao_status,
           (painel.reuniao_do_lead(l.id, l.hubspot_contact_id)).origem as reuniao_origem
    from painel.leads l
    -- evento de sistema (ex.: transferência que passou pelo SDR) não põe o lead na lista dele (2026-10-08);
    -- nota de descarte/finalizado continua pondo (o lead conta nos Descartados/DSQ do SDR)
    where (exists (select 1 from painel.chat_messages m
                    where m.lead_id = l.id and m.sdr_id = p_sdr and (m.sender <> 'system' or m.note_tag is not null)
                      and m.sent_at >= p_from and m.sent_at < p_to)
           -- lead aguardando agora entra mesmo sem mensagem no período (igual ao número "Aguardando" do card)
           or (exists (select 1 from painel.chats c
                        where c.lead_id = l.id and c.sdr_id = p_sdr and c.status = 'open' and c.waiting_since is not null)
               and painel.fora_do_funil(l.id, l.hubspot_contact_id) is null))
      and (v_search is null
           or l.name ilike '%' || v_search || '%'
           or (v_digits is not null and regexp_replace(coalesce(l.phone_e164, ''), '\D', '', 'g') like '%' || v_digits || '%'))
  ),
  stats as (
    select b.id,
           count(*) filter (where m.sender = 'template' and m.sdr_id = p_sdr) as templates,
           count(*) filter (where m.sender = 'lead' and m.sdr_id = p_sdr) as msgs_lead,
           count(*) filter (where m.by_human and m.sdr_id = p_sdr) as msgs_equipe,
           count(*) filter (where m.sender = 'lead') as msgs_lead_total,
           max(m.sent_at) filter (where m.sender = 'lead') as last_lead_at,
           max(m.sent_at) filter (where m.by_human) as last_team_at,
           (array_agg(m.sent_at order by m.sent_at desc, m.id desc) filter (where m.sender <> 'system'))[1] as last_at,
           (array_agg(m.sender::text order by m.sent_at desc, m.id desc) filter (where m.sender <> 'system'))[1] as last_from
    from base b
    join painel.chat_messages m on m.lead_id = b.id
    group by b.id
  ),
  wait as (
    -- espera atual do lead em atendimento aberto deste SDR
    select c.lead_id, min(c.waiting_since) as since
    from painel.chats c
    where c.lead_id in (select base.id from base) and c.sdr_id = p_sdr and c.status = 'open' and c.waiting_since is not null
    group by c.lead_id
  ),
  resp as (
    select c.lead_id,
           (array_agg(r.seconds_24h order by r.lead_block_started_at desc) filter (where r.is_first_response))[1] as first_s,
           percentile_cont(0.5) within group (order by r.seconds_24h) as med_s
    from painel.response_events r
    join painel.chats c on c.id = r.chat_id
    where c.lead_id in (select base.id from base) and r.sdr_id = p_sdr
      and (not v_biz or painel.is_business_time(r.lead_block_started_at))
    group by c.lead_id
  ),
  linhas as (
    select b.*,
           w.since as waiting_since,
           case when w.since is not null and b.fora_motivo is not null then 'fora_do_funil'
                when w.since is not null then 'aguardando'
                when coalesce(st.msgs_lead_total, 0) = 0 then 'lead_nao_respondeu'
                when st.last_lead_at > coalesce(st.last_team_at, '-infinity'::timestamptz) then 'encerrado_sem_resposta'
                else 'respondido' end as situacao,
           st.templates, st.msgs_lead, st.msgs_equipe, st.last_at, st.last_from, resp.first_s, resp.med_s
    from base b
    left join stats st on st.id = b.id
    left join wait w on w.lead_id = b.id
    left join resp on resp.lead_id = b.id
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
         linhas.last_at,
         linhas.last_from,
         linhas.initiated_by,
         linhas.fora_motivo,
         linhas.reuniao_status,
         linhas.reuniao_origem,
         count(*) over ()
  from linhas
  where coalesce(p_filter, 'all') = 'all'
     or (p_filter = 'waiting' and linhas.situacao = 'aguardando')
     or (p_filter = 'noreply' and linhas.situacao = 'lead_nao_respondeu')
     or (p_filter = 'booked' and linhas.reuniao_status is not null)
  order by (linhas.situacao = 'aguardando') desc, linhas.waiting_since asc nulls last, linhas.last_at desc nulls last
  limit least(greatest(coalesce(p_limit, 50), 1), 200)
  offset greatest(coalesce(p_offset, 0), 0);
end;
$$;
