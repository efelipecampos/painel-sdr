-- Acesso global do SDR (decisão do Felipe, 2026-10-08). Revoga a regra de 2026-10-07 (docs/agendamento.md, seção 3).
-- O SDR passa a ver tudo de todos (painel do time, lista de qualquer SDR, todas as reuniões), agendar lead de qualquer
-- carteira e marcar qualquer status (agendada, validada, no-show, invalidada, cancelada), inclusive nas reuniões feitas
-- fora do painel. Motivo: férias, falta e cobertura de agenda entre SDRs.
-- Continua só de admin e gestor: Usuários, Carrosséis, Configurações, Relatório, aprovar pedido de troca e trocar closer.
-- Closer continua vendo só as próprias reuniões.

-- Admin, gestor ou SDR ativo (ou o servidor). Closer e quem não tem perfil ficam de fora.
create function painel.pode_ver_tudo()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '') = 'service_role'
      or exists (
        select 1 from painel.profiles p
        where p.id = (select auth.uid()) and p.active
          and (p.role in ('admin', 'gestor') or (p.role = 'sdr' and p.sdr_id is not null))
      );
$$;
revoke execute on function painel.pode_ver_tudo() from public, anon;
grant execute on function painel.pode_ver_tudo() to authenticated, service_role;

-- Escopo de leitura: SDR ativo agora devolve null (todos), como admin e gestor.
create or replace function painel.escopo_sdr()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_sdr uuid;
  v_active boolean;
begin
  if coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '') = 'service_role' then
    return null;
  end if;
  select p.role::text, p.sdr_id, p.active into v_role, v_sdr, v_active
  from painel.profiles p where p.id = (select auth.uid());
  if v_role is null or not v_active then
    raise exception 'acesso negado' using errcode = '42501';
  end if;
  -- SDR vê tudo de todos, como o gestor (decisão de 2026-10-08). A tela continua abrindo na lista dele.
  if v_role in ('admin', 'gestor') or (v_role = 'sdr' and v_sdr is not null) then
    return null;
  end if;
  raise exception 'acesso negado' using errcode = '42501';
end;
$$;

-- Visão do time (cards e totais do painel principal).
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

-- Marcar à mão o status da reunião feita fora do painel (seletor na lista do SDR).
create or replace function painel.set_meeting_status(p_lead uuid, p_status text)
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
  if not painel.pode_ver_tudo() then   -- marcar reunião à mão: admin, gestor e SDR (decisão de 2026-10-08)
    raise exception 'acesso negado' using errcode = '42501';
  end if;
  if p_status is not null and p_status not in ('agendada', 'validada', 'invalidada', 'noshow', 'cancelada') then
    raise exception 'status de reunião inválido: %', p_status using errcode = '22023';
  end if;
  if not exists (select 1 from painel.leads where id = p_lead) then
    raise exception 'lead não encontrado' using errcode = 'P0002';
  end if;

  select * into v_old from painel.meetings where lead_id = p_lead and source = 'manual';

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
  on conflict (lead_id) where source = 'manual' do update
    set status = excluded.status, source = 'manual', status_changed_at = now(), status_changed_by = v_user,
        sdr_id = coalesce(painel.meetings.sdr_id, excluded.sdr_id)
  returning * into v_old;

  insert into painel.meeting_status_history (meeting_id, lead_id, from_status, to_status, source, changed_by)
  values (v_old.id, p_lead,
          (select h.to_status from painel.meeting_status_history h where h.lead_id = p_lead order by h.changed_at desc limit 1),
          v_new, 'manual', v_user);
end;
$$;

-- Reuniões do painel: o SDR pode mexer em qualquer uma.
create or replace function painel.permissao_reuniao(p_id uuid)
returns text  -- 'gestor' | 'closer' | 'sdr'
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p.role in ('admin', 'gestor') then 'gestor'
    when p.role = 'closer' and m.closer_id = p.sdr_id then 'closer'
    when p.role = 'sdr' and p.sdr_id is not null then 'sdr'   -- qualquer reunião (decisão de 2026-10-08)
  end
  from painel.profiles p
  join painel.meetings m on m.id = p_id and m.source = 'painel'
  where p.id = (select auth.uid()) and p.active;
$$;

-- Status: o SDR pode marcar qualquer um (antes só confirmava o cancelamento).
create or replace function painel.definir_status_reuniao(p_id uuid, p_status text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_perm text := painel.permissao_reuniao(p_id);
  v_old painel.meeting_status;
begin
  if v_perm is null then
    raise exception 'acesso negado' using errcode = '42501';
  end if;
  if p_status not in ('agendada', 'validada', 'noshow', 'invalidada', 'cancelada') then
    raise exception 'status inválido' using errcode = '22023';
  end if;
  select m.status into v_old from painel.meetings m where m.id = p_id for update;
  if v_old::text = p_status then
    return v_old::text;
  end if;
  update painel.meetings
     set status = p_status::painel.meeting_status, status_changed_at = now(), status_changed_by = (select auth.uid()),
         google_state = case when p_status = 'cancelada' then null else google_state end
   where id = p_id;
  insert into painel.meeting_status_history (meeting_id, from_status, to_status, source, changed_by)
  values (p_id, v_old, p_status::painel.meeting_status, 'painel', (select auth.uid()));
  return v_old::text;
end;
$$;

-- Tela Reuniões: o SDR vê todas.
create or replace function painel.reunioes_lista(p_from timestamptz, p_to timestamptz)
returns table (id uuid, starts_at timestamptz, ends_at timestamptz, status text, title text, lead_name text, company text,
               carousel text, brand text, closer text, sdr text, fora_do_padrao boolean, google_state text, permissao text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_sdr uuid;
  v_uid uuid := (select auth.uid());
begin
  select p.role::text, p.sdr_id into v_role, v_sdr from painel.profiles p where p.id = v_uid and p.active;
  if v_role is null then
    raise exception 'acesso negado' using errcode = '42501';
  end if;
  return query
  select m.id, m.starts_at, m.ends_at, m.status::text, m.title, m.lead_name, m.company, ca.name, ca.brand::text,
         cl.name, sd.name, m.fora_do_padrao, m.google_state,
         case when v_role in ('admin', 'gestor') then 'gestor' when v_role = 'closer' then 'closer' else 'sdr' end
  from painel.meetings m
  left join painel.carousels ca on ca.id = m.carousel_id
  left join painel.sdrs cl on cl.id = m.closer_id
  left join painel.sdrs sd on sd.id = m.sdr_id
  where m.source = 'painel' and m.starts_at >= p_from and m.starts_at < p_to
    and (v_role in ('admin', 'gestor')
         or (v_role = 'closer' and m.closer_id = v_sdr)
         or (v_role = 'sdr' and v_sdr is not null))   -- SDR vê todas (decisão de 2026-10-08)
  order by m.starts_at;
end;
$$;

-- Passagem de bastão: o SDR abre qualquer reunião do painel.
create or replace function painel.reuniao_detalhe(p_id uuid)
returns table (id uuid, starts_at timestamptz, ends_at timestamptz, status text, title text, carousel text, brand text,
               closer text, sdr text, lead_name text, company text, lead_email text, hubspot_contact_id text,
               handoff text, meet_url text, fora_do_padrao boolean, google_state text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_sdr uuid;
begin
  select p.role::text, p.sdr_id into v_role, v_sdr from painel.profiles p where p.id = (select auth.uid()) and p.active;
  if v_role is null then
    raise exception 'acesso negado' using errcode = '42501';
  end if;
  if v_role not in ('admin', 'gestor', 'sdr') and not exists (   -- SDR abre qualquer uma (decisão de 2026-10-08)
    select 1 from painel.meetings m
    where m.id = p_id and (m.closer_id = v_sdr or m.sdr_id = v_sdr or m.created_by = (select auth.uid()))
  ) then
    raise exception 'acesso negado' using errcode = '42501';
  end if;
  return query
  select m.id, m.starts_at, m.ends_at, m.status::text, m.title, ca.name, ca.brand::text, cl.name, sd.name,
         m.lead_name, m.company, m.lead_email, m.hubspot_contact_id, m.handoff, m.meet_url, m.fora_do_padrao, m.google_state
  from painel.meetings m
  left join painel.carousels ca on ca.id = m.carousel_id
  left join painel.sdrs cl on cl.id = m.closer_id
  left join painel.sdrs sd on sd.id = m.sdr_id
  where m.id = p_id and m.source = 'painel';
end;
$$;

-- Pedidos de troca de closer: o SDR vê todos (para não pedir de novo numa reunião que já tem pedido).
create or replace function painel.pedidos_troca(p_status text default 'pendente')
returns table (id uuid, meeting_id uuid, status text, reason text, created_at timestamptz, decided_at timestamptz,
               decision_note text, sdr text, lead_name text, starts_at timestamptz, closer_atual text, de text, para text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_uid uuid := (select auth.uid());
begin
  select p.role::text into v_role from painel.profiles p where p.id = v_uid and p.active;
  if v_role is null or v_role = 'closer' then
    raise exception 'acesso negado' using errcode = '42501';
  end if;
  return query
  select r.id, r.meeting_id, r.status, r.reason, r.created_at, r.decided_at, r.decision_note, pr.name, m.lead_name,
         m.starts_at, cl.name, f.name, t.name
  from painel.closer_swap_requests r
  join painel.meetings m on m.id = r.meeting_id
  join painel.profiles pr on pr.id = r.requested_by
  left join painel.sdrs cl on cl.id = m.closer_id
  left join painel.sdrs f on f.id = r.from_closer
  left join painel.sdrs t on t.id = r.to_closer
  where (p_status is null or r.status = p_status)
    and v_role in ('admin', 'gestor', 'sdr')   -- SDR vê todos os pedidos; decidir continua com o gestor (2026-10-08)
  order by r.created_at desc
  limit 200;
end;
$$;
