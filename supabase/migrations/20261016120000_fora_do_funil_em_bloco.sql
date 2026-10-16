-- Lentidão do painel (2026-10-16, aprovado pelo Felipe): painel.fora_do_funil rodava uma vez por chat aberto (~600 chats,
-- 3 a 3,6 s por uso) dentro das métricas do time, das métricas por SDR e da lista de chats do SDR, com a tela se
-- atualizando a cada 60 s. Às 10h de 16/10 o painel passou do tempo limite do banco.
-- painel.fora_do_funil_lote faz a mesma conta para vários leads de uma vez. As regras são as de
-- 20261013140000_reativacao_volta_ao_funil.sql, sem mudança:
--   1. Lead mais recente do contato no HubSpot numa etapa excluída (settings.hubspot_excluded_stages), a não ser que
--      um template tenha saído depois da entrada em Descartado ou DSQ - BR (reativação);
--   2. senão, a nota (descarte, DSQ, finalizado) ou a finalização pelo painel mais recente, a não ser que um template
--      tenha saído depois dela ou que exista Lead mais novo no HubSpot fora das etapas excluídas.
-- sdr_metrics e team_metrics são as versões de 20261015120000_abordados_qualquer_mensagem.sql (sessão a4) com só o
-- trecho de "aguardando" trocado; sdr_chats é a de 20261008230000_transferencia.sql com só a montagem da lista trocada.
-- painel.fora_do_funil (um lead por vez) continua existindo, igual.

create function painel.fora_do_funil_lote(p_leads uuid[])
returns table (lead_id uuid, motivo text)
language sql
stable
set search_path = ''
as $$
  with cfg as (
    select coalesce((select array(select jsonb_array_elements_text(s.value)) from painel.settings s where s.key = 'hubspot_excluded_stages'), '{}') as excl,
           (select s.value #>> '{}' from painel.settings s where s.key = 'hubspot_stage_descartado') as st_desc,
           (select s.value #>> '{}' from painel.settings s where s.key = 'hubspot_stage_dsq') as st_dsq
  ),
  ls as (
    select l.id, l.hubspot_contact_id as contato from painel.leads l where l.id = any(p_leads)
  ),
  tpl as (
    select m.lead_id, max(m.sent_at) as em
    from painel.chat_messages m
    where m.lead_id = any(p_leads) and m.sender = 'template'
    group by m.lead_id
  ),
  -- mesmo critério da view painel.contact_hubspot_stage: o Lead mais recente do contato
  ult as (
    select distinct on (h.hubspot_contact_id)
           h.hubspot_contact_id, h.stage_id, s.label as stage_label, h.entered_descartado_at, h.entered_dsq_at
    from painel.hubspot_leads h
    left join painel.hubspot_stages s on s.stage_id = h.stage_id
    where h.hubspot_contact_id in (select ls.contato from ls where ls.contato is not null)
    order by h.hubspot_contact_id, h.created_at desc nulls last, h.hubspot_lead_id desc
  ),
  por_etapa as (
    select ls.id, u.stage_label
    from ls
    join ult u on u.hubspot_contact_id = ls.contato
    cross join cfg
    left join tpl on tpl.lead_id = ls.id
    where u.stage_id = any(cfg.excl)
      and not coalesce(tpl.em > case u.stage_id when cfg.st_desc then u.entered_descartado_at
                                                when cfg.st_dsq then u.entered_dsq_at end, false)
  ),
  nota as (
    select distinct on (x.lead_id) x.lead_id, x.motivo, x.em
    from (
      select m.lead_id,
             case m.note_tag when 'finalizado' then 'Finalizado (nota)' when 'dsq' then 'DSQ (nota)' else 'Descartado (nota)' end as motivo,
             m.sent_at as em
      from painel.chat_messages m
      where m.lead_id = any(p_leads) and m.note_tag is not null
      union all
      select f.lead_id, 'Finalizado (painel)', f.finalized_at
      from painel.lead_finalizacoes f
      where f.lead_id = any(p_leads) and f.undone_at is null
    ) x
    order by x.lead_id, x.em desc
  ),
  por_nota as (
    select n.lead_id as id, n.motivo
    from nota n
    join ls on ls.id = n.lead_id
    cross join cfg
    left join tpl on tpl.lead_id = n.lead_id
    where not coalesce(tpl.em > n.em, false)
      and not exists (
        select 1 from painel.hubspot_leads h
        where ls.contato is not null and h.hubspot_contact_id = ls.contato and h.created_at > n.em
          and h.stage_id <> all(cfg.excl)
      )
  )
  select ls.id, coalesce(pe.stage_label, pn.motivo)
  from ls
  left join por_etapa pe on pe.id = ls.id
  left join por_nota pn on pn.id = ls.id;
$$;
revoke execute on function painel.fora_do_funil_lote(uuid[]) from public, anon, authenticated;
grant execute on function painel.fora_do_funil_lote(uuid[]) to service_role;

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
