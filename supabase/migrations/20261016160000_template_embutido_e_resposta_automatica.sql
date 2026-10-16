-- Disparo pelo Poli e respostas automáticas (decisões do Felipe, 2026-10-16):
--   1. Template "embutido": envios feitos pelo próprio Poli (disparo, mensagem rápida) chegam sem o campo template,
--      com o template da Meta em components (o parser do worker passa a tratar como template). O disparo do gestor
--      no chat da SDR conta para a SDR, como já contava. painel.poli_templates guarda o nome da Meta (meta_name)
--      para dar o nome do template no Poli a essas mensagens e para a jornada reconhecer o clique nelas.
--   2. Resposta automática: mensagem do lead que chega menos de 30 s depois de uma mensagem nossa, sem ser clique ou
--      citação, de lead que não escreveu nas 24 h anteriores. Não conta como resposta, não abre "Aguardando" e não
--      entra no tempo de resposta; a lista mostra "Resposta automática".
--   3. Lead descartado que recebe template e responde de verdade volta ao funil (regra de 2026-10-13, sem mudança).
-- Cada função abaixo é a versão mais recente com só esses pontos trocados: rebuild_leads de
-- 20261008230000_transferencia.sql; sdr_metrics, team_metrics e sdr_chats de 20261016120000_fora_do_funil_em_bloco.sql;
-- jornada_funil de 20261015180000_jornada_funil_rapido.sql.

alter table painel.poli_templates add column meta_name text;
create index poli_templates_meta_name_idx on painel.poli_templates (meta_name) where meta_name is not null;

alter table painel.chat_messages add column auto_reply boolean not null default false;

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
             coalesce(l.sent_at - (select max(o.sent_at) from painel.chat_messages o
                                    where o.lead_id = l.lead_id and o.sender in ('sdr', 'template', 'bot')
                                      and o.sent_at <= l.sent_at) < interval '30 seconds', false)
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
  update painel.chats c
     set waiting_since = case when c.status = 'open' then w.since end
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
  descartados integer,       -- Leads do HubSpot que entraram em "Descartado" no período, pelo dono do Lead
  agendados integer          -- leads que agendaram no período (HubSpot ou marcação manual)
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_scope uuid := painel.escopo_sdr();  -- null = todos (admin, gestor, servidor); senão, só este SDR
  v_biz boolean := coalesce(p_business_only,
                            (select (s.value #>> '{}')::boolean from painel.settings s where s.key = 'metrics_business_only'),
                            true);
  v_stale_min integer := coalesce((select (s.value #>> '{}')::integer from painel.settings s where s.key = 'stale_minutes'), 30);
  v_stale_biz boolean := coalesce((select (s.value #>> '{}')::boolean from painel.settings s where s.key = 'stale_business_only'), false);
begin
  -- O acesso já foi conferido por painel.escopo_sdr() (levanta 'acesso negado').

  return query
  with team as (
    -- ativos, e os desativados que tiveram mensagem no período (o passado não some quando alguém sai)
    select t.id, t.name from painel.sdrs t
    where t.role = 'sdr' and (v_scope is null or t.id = v_scope)
      and (t.active or exists (select 1 from painel.chat_messages x
                               where x.sdr_id = t.id and x.sent_at >= p_from and x.sent_at < p_to))
  ),
  msg as (
    select m.sdr_id,
           count(distinct m.lead_id) filter (where m.sender in ('sdr', 'template', 'bot')) as abordados,
           count(*) filter (where m.sender = 'template') as templates,
           count(distinct m.lead_id) filter (where m.sender = 'lead' and not m.auto_reply) as responderam
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
    where c.status = 'open' and c.waiting_since is not null and c.sdr_id in (select team.id from team)
      -- descartado/qualificado no HubSpot ou por nota não conta (calculado em bloco: painel.fora_do_funil_lote)
      and c.lead_id not in (select f.lead_id from painel.fora_do_funil_lote(array(
            select c2.lead_id from painel.chats c2
            where c2.status = 'open' and c2.waiting_since is not null and c2.sdr_id in (select team.id from team))) f
          where f.motivo is not null)
    group by c.sdr_id
  )
  , ag as (
    select a.sdr_id, count(distinct a.lead_key) as n
    from painel.agendamentos(p_from, p_to) a
    where a.sdr_id in (select team.id from team)
    group by a.sdr_id
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
         coalesce(disc.n, 0)::integer,
         coalesce(ag.n, 0)::integer
  from team
  left join msg on msg.sdr_id = team.id
  left join resp on resp.sdr_id = team.id
  left join wait on wait.sdr_id = team.id
  left join disc on disc.sdr_id = team.id
  left join ag on ag.sdr_id = team.id
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
  dsq integer,               -- Leads que entraram em "DSQ - BR" no período (qualquer dono)
  disparo_mediana_s integer, -- mediana do tempo cadastro (Lead no HubSpot) → 1º template do app token
  cadastros integer,         -- Leads criados no [New] Pipeline SDR no período
  cadastros_sem_disparo integer, -- desses, fora de DSQ e sem template do app token em até 30 min
  agendados integer          -- leads que agendaram no período (SDRs)
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
  if not painel.pode_ver_tudo() then   -- a visão do time: admin, gestor e SDR (decisão de 2026-10-08)
    raise exception 'acesso negado' using errcode = '42501';
  end if;

  return query
  -- a soma do time conta todos os SDRs, inclusive os desativados (o passado não muda quando alguém sai)
  with team as (
    select t.id from painel.sdrs t where t.role = 'sdr'
  )
  select (select count(*) from painel.sdrs t
          where t.role = 'sdr' and (t.active or exists (select 1 from painel.chat_messages x
                                                          where x.sdr_id = t.id and x.sent_at >= p_from and x.sent_at < p_to)))::integer,
         m.abordados::integer, m.templates::integer, m.responderam::integer,
         round(r.p_first)::integer, r.n_first::integer, round(r.p_all)::integer, r.n_all::integer,
         w.n::integer, w.stale::integer,
         (select count(distinct d.lead_key) from painel.descartes(p_from, p_to) d
           where d.sdr_id in (select team.id from team))::integer,
         painel.dsq_count(p_from, p_to),
         disp.mediana_s, disp.cadastros, disp.sem_disparo,
         (select count(distinct a.lead_key) from painel.agendamentos(p_from, p_to) a
           where a.sdr_id in (select team.id from team))::integer
  from painel.disparo_app_token(p_from, p_to) disp,
  (
    select count(distinct x.lead_id) filter (where x.sender in ('sdr', 'template', 'bot')) as abordados,
           count(*) filter (where x.sender = 'template') as templates,
           count(distinct x.lead_id) filter (where x.sender = 'lead' and not x.auto_reply) as responderam
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
    where c.status = 'open' and c.waiting_since is not null and c.sdr_id in (select team.id from team)
      -- descartado/qualificado no HubSpot ou por nota não conta (calculado em bloco: painel.fora_do_funil_lote)
      and c.lead_id not in (select f.lead_id from painel.fora_do_funil_lote(array(
            select c2.lead_id from painel.chats c2
            where c2.status = 'open' and c2.waiting_since is not null and c2.sdr_id in (select team.id from team))) f
          where f.motivo is not null)
  ) w;
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
  situacao text,              -- aguardando | respondido | lead_nao_respondeu | resposta_automatica | encerrado_sem_resposta | fora_do_funil
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
  with cand as (
    select l.id, l.poli_contact_uuid, l.name as lead_name, l.phone_e164, l.initiated_by, l.hubspot_contact_id,
           exists (select 1 from painel.chat_messages m
                    where m.lead_id = l.id and m.sdr_id = p_sdr and (m.sender <> 'system' or m.note_tag is not null)
                      and m.sent_at >= p_from and m.sent_at < p_to) as no_periodo,
           exists (select 1 from painel.chats c
                    where c.lead_id = l.id and c.sdr_id = p_sdr and c.status = 'open' and c.waiting_since is not null) as aguardando
    from painel.leads l
    where (v_search is null
           or l.name ilike '%' || v_search || '%'
           or (v_digits is not null and regexp_replace(coalesce(l.phone_e164, ''), '\D', '', 'g') like '%' || v_digits || '%'))
  ),
  cand2 as (select * from cand where cand.no_periodo or cand.aguardando),
  fora as (select f.lead_id, f.motivo from painel.fora_do_funil_lote(array(select cand2.id from cand2)) f),
  base as (
    select c.id, c.poli_contact_uuid, c.lead_name, c.phone_e164, c.initiated_by,
           fo.motivo as fora_motivo,
           r.status as reuniao_status,
           r.origem as reuniao_origem
    from cand2 c
    left join fora fo on fo.lead_id = c.id
    cross join lateral painel.reuniao_do_lead(c.id, c.hubspot_contact_id) r
    -- evento de sistema (ex.: transferência que passou pelo SDR) não põe o lead na lista dele (2026-10-08);
    -- nota de descarte/finalizado continua pondo (o lead conta nos Descartados/DSQ do SDR)
    -- lead aguardando agora entra mesmo sem mensagem no período (igual ao número "Aguardando" do card)
    where c.no_periodo or (c.aguardando and fo.motivo is null)
  ),
  stats as (
    select b.id,
           count(*) filter (where m.sender = 'template' and m.sdr_id = p_sdr) as templates,
           count(*) filter (where m.sender = 'lead' and not m.auto_reply and m.sdr_id = p_sdr) as msgs_lead,
           count(*) filter (where m.by_human and m.sdr_id = p_sdr) as msgs_equipe,
           count(*) filter (where m.sender = 'lead' and not m.auto_reply) as msgs_lead_total,
           count(*) filter (where m.sender = 'lead' and m.auto_reply) as msgs_auto,
           max(m.sent_at) filter (where m.sender = 'lead' and not m.auto_reply) as last_lead_at,
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
                when coalesce(st.msgs_lead_total, 0) = 0 and coalesce(st.msgs_auto, 0) > 0 then 'resposta_automatica'
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

create or replace function painel.jornada_funil(p_from timestamptz, p_to timestamptz)
returns table (etapa integer, nome text, expediente integer, fora integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_pipe text := (select s.value #>> '{}' from painel.settings s where s.key = 'hubspot_pipeline_sdr');
  v_dsq text := (select s.value #>> '{}' from painel.settings s where s.key = 'hubspot_stage_dsq');
begin
  if not painel.is_manager() then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  return query
  with base as materialized (
    select distinct on (h.hubspot_contact_id) h.hubspot_contact_id as contato, h.created_at as criado
    from painel.hubspot_leads h
    where h.pipeline_id = v_pipe and h.hubspot_contact_id is not null
      and h.created_at >= p_from and h.created_at < p_to
      and h.entered_dsq_at is null and h.stage_id is distinct from v_dsq
    order by h.hubspot_contact_id, h.created_at
  ),
  tpl as materialized (
    select distinct on (b.contato) b.contato, m.sent_at as t_at, m.raw_event_id, m.lead_id
    from base b
    join painel.leads l on l.hubspot_contact_id = b.contato
    join painel.chat_messages m on m.lead_id = l.id and m.sender = 'template' and m.sent_at >= b.criado - interval '1 minute'
    order by b.contato, m.sent_at
  ),
  resposta as materialized (
    select distinct on (t.contato) t.contato, m.sender, m.body, t.raw_event_id
    from tpl t
    join painel.chat_messages m on m.lead_id = t.lead_id and m.sent_at > t.t_at
      and ((m.sender = 'lead' and not m.auto_reply) or m.sender = 'template')
    order by t.contato, m.sent_at
  ),
  clicou as materialized (
    select distinct r.contato
    from resposta r
    join public.raw_events e on e.id = r.raw_event_id
    cross join lateral jsonb_array_elements(coalesce(e.payload -> 'value' -> 'template' -> 'message' -> 'buttons', '[]'::jsonb)) bt
    where r.sender = 'lead' and bt ->> 'type' = 'reply'
      and lower(btrim(regexp_replace(r.body, '\s+', ' ', 'g'))) = lower(btrim(regexp_replace(bt ->> 'text', '\s+', ' ', 'g')))
  ),
  agendou as materialized (
    select b.contato from base b
      join painel.leads l on l.hubspot_contact_id = b.contato
      join painel.meetings mt on mt.lead_id = l.id and mt.created_at >= b.criado - interval '1 minute'
    union
    select b.contato from base b
      join painel.meetings mt on mt.hubspot_contact_id = b.contato and mt.created_at >= b.criado - interval '1 minute'
    union
    select b.contato from base b
      join painel.hubspot_leads h on h.hubspot_contact_id = b.contato and h.pipeline_id = v_pipe
        and h.created_at >= b.criado and h.entered_agendado_at is not null
  ),
  c as materialized (
    select b.contato, painel.is_business_time(b.criado) as exp,
      t.contato is not null as enviou, k.contato is not null as clicou, a.contato is not null as agendou
    from base b
    left join tpl t on t.contato = b.contato
    left join clicou k on k.contato = b.contato
    left join (select distinct contato from agendou) a on a.contato = b.contato
  )
  select x.etapa, x.nome,
    count(*) filter (where c.exp and x.ok)::integer,
    count(*) filter (where not c.exp and x.ok)::integer
  from c
  cross join lateral (values
    (1, 'Lead criado', true),
    (2, 'Template 1 enviado', c.enviou),
    (3, 'Clicou em um dos botões', c.clicou),
    (4, 'Agendamento', c.agendou)
  ) as x(etapa, nome, ok)
  group by x.etapa, x.nome
  order by x.etapa;
end;
$$;
