-- Fase 6: agendamentos (decisões de 2026-10-07).
-- "Agendada" vem do HubSpot: o Lead mais recente do contato passou por "Garantir Agendamento" ou "Qualificado"
-- (settings.hubspot_agendado_stages). Os demais status (validada, invalidada, noshow, cancelada) são marcados à
-- mão por admin ou gestor no painel, e o HubSpot nunca os sobrescreve. Sem data da reunião por enquanto.
-- Uma marcação por lead (painel.meetings), com histórico de toda mudança (painel.meeting_status_history).

alter table painel.hubspot_leads add column entered_agendado_at timestamptz; -- 1ª entrada numa etapa de agendamento
create index hubspot_leads_agendado_idx on painel.hubspot_leads (entered_agendado_at) where entered_agendado_at is not null;

insert into painel.settings (key, value) values ('hubspot_agendado_stages', '["1250901139", "1358962969"]')
on conflict (key) do nothing;
-- A releitura dos Leads desde 25/09 (para preencher entered_agendado_at) é feita depois do deploy do worker:
-- npx tsx apps/worker/src/index.ts --hubspot-desde 2026-09-25

-- Marcação manual: uma por lead.
alter table painel.meetings alter column chat_id drop not null;
alter table painel.meetings add column created_at timestamptz not null default now();
create unique index meetings_lead_uidx on painel.meetings (lead_id);

-- Histórico sobrevive à remoção da marcação.
alter table painel.meeting_status_history add column lead_id uuid references painel.leads;
alter table painel.meeting_status_history alter column meeting_id drop not null;
alter table painel.meeting_status_history drop constraint meeting_status_history_meeting_id_fkey;
alter table painel.meeting_status_history
  add constraint meeting_status_history_meeting_id_fkey foreign key (meeting_id) references painel.meetings on delete set null;
create index meeting_status_history_lead_idx on painel.meeting_status_history (lead_id, changed_at);

-- Reunião atual do lead: marcação manual, senão "agendada" se o Lead mais recente no HubSpot agendou.
create function painel.reuniao_do_lead(p_lead uuid, p_hubspot_contact_id text, out status text, out origem text)
language sql
stable
set search_path = ''
as $$
  select coalesce(m.status::text, case when hs.agendou then 'agendada' end),
         case when m.status is not null then 'manual' when hs.agendou then 'hubspot' end
  from (select 1) x
  left join painel.meetings m on m.lead_id = p_lead
  left join lateral (
    select h.entered_agendado_at is not null as agendou
    from painel.hubspot_leads h
    where p_hubspot_contact_id is not null and h.hubspot_contact_id = p_hubspot_contact_id
    order by h.created_at desc nulls last, h.hubspot_lead_id desc
    limit 1
  ) hs on true;
$$;
revoke execute on function painel.reuniao_do_lead(uuid, text) from public, anon, authenticated;
grant execute on function painel.reuniao_do_lead(uuid, text) to service_role;

-- Leads que agendaram no período, com o SDR: entrada em agendamento no HubSpot (dono do Lead) ou marcação
-- manual criada no período (SDR da marcação). O mesmo lead conta uma vez.
create function painel.agendamentos(p_from timestamptz, p_to timestamptz)
returns table (sdr_id uuid, lead_key text)
language sql
stable
set search_path = ''
as $$
  select sd.id, coalesce('lead:' || l.id::text, 'hs:' || coalesce(h.hubspot_contact_id, h.hubspot_lead_id))
  from painel.hubspot_leads h
  join painel.hubspot_owners o on o.owner_id = h.owner_id
  join painel.sdrs sd on lower(sd.poli_email) = lower(o.email)
  left join painel.leads l on l.hubspot_contact_id = h.hubspot_contact_id
  where h.entered_agendado_at >= p_from and h.entered_agendado_at < p_to
  union
  select m.sdr_id, 'lead:' || m.lead_id::text
  from painel.meetings m
  where m.created_at >= p_from and m.created_at < p_to and m.sdr_id is not null;
$$;
revoke execute on function painel.agendamentos(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function painel.agendamentos(timestamptz, timestamptz) to service_role;

-- Grava (ou remove, com p_status null) a marcação manual de reunião de um lead. Admin e gestor.
create function painel.set_meeting_status(p_lead uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_old painel.meetings;
  v_sdr uuid;
  v_new painel.meeting_status;
begin
  if not painel.is_active_user() then
    raise exception 'acesso negado' using errcode = '42501';
  end if;
  if p_status is not null and p_status not in ('agendada', 'validada', 'invalidada', 'noshow', 'cancelada') then
    raise exception 'status de reunião inválido: %', p_status using errcode = '22023';
  end if;
  if not exists (select 1 from painel.leads where id = p_lead) then
    raise exception 'lead não encontrado' using errcode = 'P0002';
  end if;

  select * into v_old from painel.meetings where lead_id = p_lead;

  if p_status is null then
    if v_old.id is not null then
      insert into painel.meeting_status_history (meeting_id, lead_id, from_status, to_status, source, changed_by)
      values (v_old.id, p_lead, v_old.status, null, 'manual', v_user);
      delete from painel.meetings where id = v_old.id;
    end if;
    return;
  end if;

  v_new := p_status::painel.meeting_status;
  if v_old.id is not null and v_old.status = v_new then
    return;
  end if;

  -- SDR: dono atual do atendimento mais recente do lead que é SDR.
  select c.sdr_id into v_sdr
  from painel.chats c join painel.sdrs s on s.id = c.sdr_id
  where c.lead_id = p_lead and s.role = 'sdr'
  order by c.last_activity_at desc nulls last, c.opened_at desc
  limit 1;

  insert into painel.meetings (lead_id, sdr_id, status, source, status_changed_at, status_changed_by)
  values (p_lead, v_sdr, v_new, 'manual', now(), v_user)
  on conflict (lead_id) do update
    set status = excluded.status, source = 'manual', status_changed_at = now(), status_changed_by = v_user,
        sdr_id = coalesce(painel.meetings.sdr_id, excluded.sdr_id)
  returning * into v_old;

  insert into painel.meeting_status_history (meeting_id, lead_id, from_status, to_status, source, changed_by)
  values (v_old.id, p_lead,
          (select h.to_status from painel.meeting_status_history h where h.lead_id = p_lead order by h.changed_at desc limit 1),
          v_new, 'manual', v_user);
end;
$$;
revoke execute on function painel.set_meeting_status(uuid, text) from public, anon;
grant execute on function painel.set_meeting_status(uuid, text) to authenticated, service_role;

-- Funções da tela com as colunas novas (o tipo de retorno muda: precisa recriar).
drop function painel.sdr_metrics(timestamptz, timestamptz, boolean);
drop function painel.team_metrics(timestamptz, timestamptz, boolean);
drop function painel.sdr_chats(uuid, timestamptz, timestamptz, boolean, text, text, integer, integer);

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
         disp.mediana_s, disp.cadastros, disp.sem_disparo,
         (select count(distinct a.lead_key) from painel.agendamentos(p_from, p_to) a
           where a.sdr_id in (select team.id from team))::integer
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
    select l.id, l.poli_contact_uuid, l.name as lead_name, l.phone_e164, l.initiated_by,
           painel.fora_do_funil(l.id, l.hubspot_contact_id) as fora_motivo,
           (painel.reuniao_do_lead(l.id, l.hubspot_contact_id)).status as reuniao_status,
           (painel.reuniao_do_lead(l.id, l.hubspot_contact_id)).origem as reuniao_origem
    from painel.leads l
    where exists (select 1 from painel.chat_messages m
                   where m.lead_id = l.id and m.sdr_id = p_sdr and m.sent_at >= p_from and m.sent_at < p_to)
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

revoke execute on function painel.sdr_metrics(timestamptz, timestamptz, boolean) from public, anon;
revoke execute on function painel.team_metrics(timestamptz, timestamptz, boolean) from public, anon;
revoke execute on function painel.sdr_chats(uuid, timestamptz, timestamptz, boolean, text, text, integer, integer) from public, anon;
grant execute on function painel.sdr_metrics(timestamptz, timestamptz, boolean) to authenticated, service_role;
grant execute on function painel.team_metrics(timestamptz, timestamptz, boolean) to authenticated, service_role;
grant execute on function painel.sdr_chats(uuid, timestamptz, timestamptz, boolean, text, text, integer, integer) to authenticated, service_role;
