-- Fase 10b (complemento): remover closer de um carrossel e tela Usuários (desativar sem perder dados).
-- Decisões do Felipe em 2026-10-07: só ele (admin) e o Timóteo desativam usuários; quem é desativado perde o
-- acesso na hora e sai das listas e dos carrosséis, mas nada é apagado; a soma do time sempre conta todo mundo
-- e a lista de SDRs mostra o desativado só nos períodos em que ele teve atividade.

-- 1. Remover closer de um carrossel (o livro-caixa e as reuniões continuam guardados).
grant delete on painel.carousel_members to authenticated;

-- 2. Quem pode gerenciar usuários: o admin e quem tiver a marcação (hoje, o Timóteo).
alter table painel.profiles add column can_manage_users boolean not null default false;
update painel.profiles p set can_manage_users = true
from auth.users u where u.id = p.id and lower(u.email) = 'timoteo.luis@poli.digital';

create function painel.pode_gerenciar_usuarios()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from painel.profiles p
    where p.id = (select auth.uid()) and p.active and (p.role = 'admin' or p.can_manage_users)
  );
$$;
revoke execute on function painel.pode_gerenciar_usuarios() from public, anon;
grant execute on function painel.pode_gerenciar_usuarios() to authenticated, service_role;

-- Lista de pessoas: atendentes da Poli (SDR, closer, gestor, robô) e logins do painel, numa linha por pessoa.
-- O login de gestor/admin se liga ao atendente pelo e-mail; o de SDR, pelo sdr_id.
create function painel.usuarios()
returns table (sdr_id uuid, profile_id uuid, name text, email text, papel text, is_bot boolean, tem_login boolean, active boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not painel.pode_gerenciar_usuarios() then
    raise exception 'acesso negado' using errcode = '42501';
  end if;
  return query
  with p as (
    select pr.id, pr.name, pr.role::text as role, pr.active, pr.sdr_id, lower(u.email) as email
    from painel.profiles pr join auth.users u on u.id = pr.id
  ),
  s as (
    select sd.id, sd.name, sd.role::text as role, sd.is_bot, sd.active, lower(sd.poli_email) as email,
           (select p.id from p where p.sdr_id = sd.id or (p.sdr_id is null and p.email = lower(sd.poli_email))
            order by (p.sdr_id = sd.id) desc nulls last limit 1) as profile_id
    from painel.sdrs sd
  )
  select s.id, s.profile_id, coalesce(p.name, s.name), s.email, coalesce(p.role, s.role, 'outro'), s.is_bot,
         s.profile_id is not null, s.active and coalesce(p.active, true)
  from s left join p on p.id = s.profile_id
  union all
  select null::uuid, p.id, p.name, p.email, p.role, false, true, p.active
  from p where not exists (select 1 from s where s.profile_id = p.id)
  order by 8 desc, 3;
end;
$$;
revoke execute on function painel.usuarios() from public, anon;
grant execute on function painel.usuarios() to authenticated, service_role;

-- Desativa ou reativa uma pessoa: o atendente (sai dos cards, das listas e dos carrosséis) e o login (perde o
-- acesso na hora: todas as telas e funções exigem perfil ativo). Nada é apagado.
create function painel.definir_usuario_ativo(p_sdr uuid, p_profile uuid, p_active boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not painel.pode_gerenciar_usuarios() then
    raise exception 'acesso negado' using errcode = '42501';
  end if;
  if not p_active and p_profile = (select auth.uid()) then
    raise exception 'você não pode desativar o próprio usuário' using errcode = 'P0001';
  end if;
  if not p_active and exists (select 1 from painel.profiles where id = p_profile and role = 'admin') then
    raise exception 'o administrador não pode ser desativado por aqui' using errcode = 'P0001';
  end if;
  if p_sdr is not null then
    update painel.sdrs set active = p_active where id = p_sdr;
  end if;
  if p_profile is not null then
    update painel.profiles set active = p_active where id = p_profile;
  end if;
end;
$$;
revoke execute on function painel.definir_usuario_ativo(uuid, uuid, boolean) from public, anon;
grant execute on function painel.definir_usuario_ativo(uuid, uuid, boolean) to authenticated, service_role;

-- 3. Métricas: desativado continua na soma do time e aparece na lista de SDRs nos períodos em que teve atividade.
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
  if not painel.is_manager() then   -- a visão do time é só de admin e gestor
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
