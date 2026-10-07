-- Fase 10e.2: pedido de troca de closer, troca direta pelo gestor, troca de marca e relatório
-- (docs/agendamento.md, seção 5 e itens A e D de 10.1; decisões de 2026-10-07).

-- Pedidos de troca de closer feitos pelo SDR. Um pendente por reunião.
create table painel.closer_swap_requests (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references painel.meetings on delete cascade,
  requested_by uuid not null references painel.profiles,
  reason text not null check (length(trim(reason)) > 0),
  status text not null default 'pendente' check (status in ('pendente', 'aprovado', 'recusado', 'expirado')),
  created_at timestamptz not null default now(),
  decided_by uuid references painel.profiles,
  decided_at timestamptz,
  decision_note text,
  from_closer uuid references painel.sdrs,
  to_closer uuid references painel.sdrs
);
create unique index closer_swap_pending_uidx on painel.closer_swap_requests (meeting_id) where status = 'pendente';
create index closer_swap_status_idx on painel.closer_swap_requests (status, created_at);
alter table painel.closer_swap_requests enable row level security;
grant all on painel.closer_swap_requests to service_role;

insert into painel.settings (key, value) values ('swap_expire_minutes', '120')  -- expira 2 h antes da reunião
on conflict (key) do nothing;

-- O SDR da reunião abre o pedido (o servidor já conferiu que existe outro closer livre). Devolve o id.
create function painel.pedir_troca_closer(p_meeting uuid, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  m painel.meetings;
begin
  if painel.permissao_reuniao(p_meeting) is distinct from 'sdr' then
    raise exception 'acesso negado' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_reason, ''))) = 0 then
    raise exception 'a justificativa é obrigatória' using errcode = '22023';
  end if;
  select * into m from painel.meetings where id = p_meeting;
  if m.status <> 'agendada' or m.starts_at <= now() then
    raise exception 'só dá para pedir troca de reunião agendada e futura' using errcode = 'P0001';
  end if;
  insert into painel.closer_swap_requests (meeting_id, requested_by, reason, from_closer)
  values (p_meeting, (select auth.uid()), trim(p_reason), m.closer_id)
  returning id into v_id;
  return v_id;
exception when unique_violation then
  raise exception 'já existe um pedido de troca pendente para esta reunião' using errcode = 'P0001';
end;
$$;
revoke execute on function painel.pedir_troca_closer(uuid, text) from public, anon;
grant execute on function painel.pedir_troca_closer(uuid, text) to authenticated, service_role;

-- Pedidos para a tela Reuniões: gestor e admin veem todos; o SDR vê os dele.
create function painel.pedidos_troca(p_status text default 'pendente')
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
    and (v_role in ('admin', 'gestor') or r.requested_by = v_uid)
  order by r.created_at desc
  limit 200;
end;
$$;
revoke execute on function painel.pedidos_troca(text) from public, anon;
grant execute on function painel.pedidos_troca(text) to authenticated, service_role;

-- Troca pelo carrossel: entre os livres (p_livres, sem o closer atual), o de maior saldo. Só o servidor.
create function painel.trocar_closer_carrossel(p_meeting uuid, p_livres uuid[], p_motivo text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  m painel.meetings;
  c painel.carousels;
  v_closer uuid;
begin
  perform pg_advisory_xact_lock(hashtext('painel.agendamento'));
  select * into m from painel.meetings where id = p_meeting and source = 'painel';
  if m.id is null then
    raise exception 'reunião não encontrada' using errcode = 'P0002';
  end if;
  select * into c from painel.carousels where id = m.carousel_id;
  select e.closer_id into v_closer
  from painel.carousel_members e
  join painel.sdrs sd on sd.id = e.closer_id
  left join painel.carousel_saldos(c.id, painel.period_key(now(), c.balance_period)) b on b.closer_id = e.closer_id
  where e.carousel_id = c.id and e.active and e.weight > 0 and sd.active and e.closer_id <> m.closer_id
    and exists (select 1 from painel.google_connections g where g.closer_id = e.closer_id and g.status = 'conectada')
    and e.closer_id = any (coalesce(p_livres, '{}'))
    and painel.closer_livre_no_painel(e.closer_id, m.starts_at, m.ends_at, c.gap_minutes, p_meeting)
  order by coalesce(b.saldo, 0) desc, b.ultima_recebida asc nulls first, sd.name asc, e.closer_id asc
  limit 1;
  if v_closer is null then
    raise exception 'nenhum outro closer livre neste horário' using errcode = 'P0001', hint = 'sem_closer_livre';
  end if;
  perform painel.trocar_closer(p_meeting, v_closer, p_livres, p_motivo);
  update painel.meetings set assigned_by = 'carrossel' where id = p_meeting;
  return v_closer;
end;
$$;
revoke execute on function painel.trocar_closer_carrossel(uuid, uuid[], text) from public, anon, authenticated;
grant execute on function painel.trocar_closer_carrossel(uuid, uuid[], text) to service_role;

-- Pedidos pendentes de reuniões que começam em menos de swap_expire_minutes: expiram. O worker chama.
create function painel.expirar_pedidos_troca()
returns integer
language sql
security definer
set search_path = ''
as $$
  with x as (
    update painel.closer_swap_requests r set status = 'expirado', decided_at = now()
    from painel.meetings m
    where m.id = r.meeting_id and r.status = 'pendente'
      and (m.status <> 'agendada' or m.starts_at - make_interval(mins => coalesce(
            (select (s.value #>> '{}')::integer from painel.settings s where s.key = 'swap_expire_minutes'), 120)) <= now())
    returning 1
  )
  select count(*)::integer from x;
$$;
revoke execute on function painel.expirar_pedidos_troca() from public, anon, authenticated;
grant execute on function painel.expirar_pedidos_troca() to service_role;

-- Carrossel equivalente na outra marca (troca de marca): mesma faixa de usuários; sem faixa, mesmo nome.
create function painel.carrossel_outra_marca(p_carousel uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select o.id
  from painel.carousels c
  join painel.carousels o on o.brand <> c.brand and o.active
   and ((c.suggest_min_users is not distinct from o.suggest_min_users and c.suggest_max_users is not distinct from o.suggest_max_users
         and (c.suggest_min_users is not null or c.suggest_max_users is not null))
        or o.name = c.name)
  where c.id = p_carousel
  order by o.sort, o.name
  limit 1;
$$;
revoke execute on function painel.carrossel_outra_marca(uuid) from public, anon;
grant execute on function painel.carrossel_outra_marca(uuid) to authenticated, service_role;

-- Relatório para gestores (sinal de tentativa de burlar o carrossel): por SDR, no período de agendamento.
create function painel.relatorio_agendamentos(p_from timestamptz, p_to timestamptz)
returns table (sdr_id uuid, sdr text, agendadas integer, canceladas_1h integer, reagendadas_1h integer,
               pedidos integer, aprovados integer, recusados integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not painel.is_manager() then
    raise exception 'acesso negado' using errcode = '42501';
  end if;
  return query
  with ms as (
    select m.* from painel.meetings m
    where m.source = 'painel' and m.created_at >= p_from and m.created_at < p_to and m.sdr_id is not null
  )
  select s.id, s.name,
         count(distinct ms.id)::integer,
         count(distinct ms.id) filter (where exists (
           select 1 from painel.meeting_status_history h
           where h.meeting_id = ms.id and h.to_status = 'cancelada' and h.changed_at <= ms.created_at + interval '1 hour'))::integer,
         count(distinct ms.id) filter (where exists (
           select 1 from painel.meeting_changes ch
           where ch.meeting_id = ms.id and ch.changed_at <= ms.created_at + interval '1 hour'))::integer,
         (select count(*) from painel.closer_swap_requests r join ms m2 on m2.id = r.meeting_id where m2.sdr_id = s.id)::integer,
         (select count(*) from painel.closer_swap_requests r join ms m2 on m2.id = r.meeting_id where m2.sdr_id = s.id and r.status = 'aprovado')::integer,
         (select count(*) from painel.closer_swap_requests r join ms m2 on m2.id = r.meeting_id where m2.sdr_id = s.id and r.status = 'recusado')::integer
  from ms join painel.sdrs s on s.id = ms.sdr_id
  group by s.id, s.name
  order by s.name;
end;
$$;
revoke execute on function painel.relatorio_agendamentos(timestamptz, timestamptz) from public, anon;
grant execute on function painel.relatorio_agendamentos(timestamptz, timestamptz) to authenticated, service_role;
