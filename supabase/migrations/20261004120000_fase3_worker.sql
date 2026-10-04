-- Fase 3: colunas que o worker preenche a partir de public.raw_events e a função que
-- recalcula, por lead, os pares de resposta, o histórico de donos e o estado dos chats.
-- Regras: docs/spec.md, seção 2, e decisões de 2026-10-04 em docs/COMECE-AQUI.md.

-- Papel de cada atendente da Poli (listas POLI_SDR_EMAILS / POLI_CLOSER_EMAILS / POLI_MANAGER_EMAILS).
-- Null = fora das listas (outros departamentos).
create type painel.team_role as enum ('sdr', 'closer', 'gestor');
alter table painel.sdrs add column role painel.team_role;

alter table painel.chats
  add column attendance_type text,        -- INITIATED_BY_BUSINESS | INITIATED_BY_FORWARDING | INITIATED_BY_CONTACT
  add column poli_status text,            -- último attendance.status visto (IN_PROGRESS, BOT, QUEUE, CLOSED...)
  add column closed_reason text,          -- closed_reason da Poli, ou SUBSTITUIDO (outro atendimento do lead seguiu)
  add column last_activity_at timestamptz; -- última mensagem do lead ou da equipe (para "Aguardando")
create index chats_lead_activity_idx on painel.chats (lead_id, last_activity_at);

-- Fotografia de cada evento, para o recálculo não depender da ordem de chegada.
alter table painel.chat_messages
  add column direction text,              -- IN | OUT | SYSTEM | EMPTY
  add column author_poli_uuid text,       -- quem escreveu de fato (null = app token/bot)
  add column by_human boolean not null default false, -- mensagem ou template enviado por uma pessoa da equipe
  add column message_type text,           -- value.type: TEXT, CHAT, TEMPLATE, MEDIA, PTT, NOTE...
  add column system_type text,            -- value.type quando sender = 'system'
  add column attendance_status text,
  add column attendance_type text,
  add column closed_reason text;
create index chat_messages_lead_sent_idx on painel.chat_messages (lead_id, sent_at);

-- Recalcula tudo que é derivado das mensagens dos leads informados. Idempotente: apaga e refaz.
create function painel.rebuild_leads(p_leads uuid[])
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
end;
$$;

revoke execute on function painel.rebuild_leads(uuid[]) from public, anon, authenticated;
grant execute on function painel.rebuild_leads(uuid[]) to service_role;
