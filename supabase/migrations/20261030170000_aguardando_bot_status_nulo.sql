-- Correção da regra "chat parado no bot" (20261030150000): com poli_status nulo (chat sem status da Poli) a conta
-- "poli_status = 'BOT'" dava nulo, e o chat saía de "Aguardando" mesmo sem estar no bot. Agora só sai o chat com
-- poli_status BOT de fato. Mesma função, só essa linha muda.

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

  -- 0a) Resposta automática (decisão do Felipe, 2026-10-16): robô do lado do lead ("Olá, seja bem-vindo(a)...").
  --     É a mensagem do lead que (1) chega menos de 30 s depois de uma mensagem nossa (template, pessoa ou robô),
  --     (2) não é clique de botão nem resposta citando mensagem (sem context) e (3) vem de lead que não estava
  --     conversando (nenhuma mensagem dele nas 24 h anteriores). Assim a resposta rápida de quem está conversando
  --     continua contando. Não conta como resposta nem abre "Aguardando"; a lista mostra "Resposta automática".
  update painel.chat_messages m
     set auto_reply = x.auto
    from (
      select l.id,
             (coalesce(l.sent_at - (select max(o.sent_at) from painel.chat_messages o
                                     where o.lead_id = l.lead_id and o.sender in ('sdr', 'template', 'bot')
                                       and o.sent_at <= l.sent_at) < interval '30 seconds', false)
              -- divulgação do próprio lead (2026-10-30): promoção ou catálogo dele, sem falar do assunto da Poli
              or (lower(coalesce(l.body, '')) ~ '(promo[cç][aã]o|promo[cç][oõ]es|confira|cat[aá]logo|aproveite|frete gr[aá]tis|\d+ ?% ?off|cupom|pe[cç]a j[aá]|compre j[aá]|garanta j[aá]|cole[cç][aã]o|lan[cç]amento|novidades)'
                  and lower(l.body) !~ '(whats|zap|plataforma|disparo|\mapi\M|sistema|\mapp\M|atendimento|atendente|cliente|interesse|gostaria|quero|preciso|voc[eê]s|\mvcs\M|pre[cç]o|valor|quanto)'))
             and not exists (select 1 from public.raw_events e
                              where e.id = l.raw_event_id and jsonb_typeof(e.payload -> 'value' -> 'context') = 'object')
             and not exists (select 1 from painel.chat_messages p
                              where p.lead_id = l.lead_id and p.sender = 'lead' and p.id <> l.id
                                and p.sent_at < l.sent_at and p.sent_at >= l.sent_at - interval '24 hours'
                                and not p.auto_reply) as auto
      from painel.chat_messages l
      where l.lead_id = any (p_leads) and l.sender = 'lead'
    ) x
   where m.id = x.id and m.auto_reply is distinct from x.auto;

  -- 0c) Template embutido (2026-10-16): o nome da Meta (polichat_quick_message_...) vira o nome do template no Poli.
  update painel.chat_messages m
     set template_name = t.key
    from painel.poli_templates t
   where m.lead_id = any (p_leads) and m.sender = 'template' and t.meta_name is not null and m.template_name = t.meta_name;

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
    where m.lead_id = any (p_leads) and ((m.sender = 'lead' and not m.auto_reply) or m.by_human)
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
  --    Chat parado no bot da Poli (2026-10-30): poli_status BOT e nenhuma mensagem da equipe nele não chegou à SDR,
  --    então não fica "Aguardando".
  update painel.chats c
     set waiting_since = case when c.status = 'open'
                               and not (c.poli_status is not distinct from 'BOT'
                                        and not exists (select 1 from painel.chat_messages h where h.chat_id = c.id and h.by_human))
                              then w.since end
    from (
      select c2.id,
             (select min(m.sent_at)
                from painel.chat_messages m
               where m.lead_id = c2.lead_id
                 and m.sender = 'lead' and not m.auto_reply
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

-- recalcula os leads com chat aberto sem status da Poli e sem mensagem da equipe (os que a conta nula tirou)
select painel.rebuild_leads(array_agg(distinct c.lead_id))
  from painel.chats c
 where c.status = 'open' and c.poli_status is null and c.waiting_since is null
   and not exists (select 1 from painel.chat_messages h where h.chat_id = c.id and h.by_human);
