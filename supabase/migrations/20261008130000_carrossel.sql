-- Fase 10b: carrossel de reuniões sem Google (docs/agendamento.md, seções 5 e 8).
-- Carrosséis por empresa e porte; closers com peso; livro-caixa de créditos e débitos; escolha do closer
-- de maior saldo entre os livres, com trava (uma distribuição por vez). A disponibilidade do Google entra
-- como parâmetro (p_livres); na 10c ela passa a vir do free/busy da Google Agenda.

create type painel.brand as enum ('poli', 'chatshub');

create table painel.carousels (
  id uuid primary key default gen_random_uuid(),
  brand painel.brand not null,
  name text not null,
  description text,                                   -- quando o SDR deve escolher este carrossel
  active boolean not null default true,               -- false = arquivado
  sort integer not null default 0,
  -- regras (padrões aprovados pelo Felipe em 2026-10-07)
  balance_period text not null default 'month' check (balance_period in ('month', 'week')),
  refund_noshow boolean not null default true,
  refund_cancelada boolean not null default true,
  refund_invalidada boolean not null default false,
  min_notice_minutes integer not null default 120 check (min_notice_minutes >= 0),
  window_business_days integer not null default 10 check (window_business_days between 1 and 60),
  gap_minutes integer not null default 15 check (gap_minutes between 0 and 120),
  durations integer[] not null default '{30,45,60}',
  sticky_days integer not null default 30 check (sticky_days between 0 and 365),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid
);

create table painel.carousel_members (
  carousel_id uuid not null references painel.carousels on delete cascade,
  closer_id uuid not null references painel.sdrs,
  weight integer not null default 1 check (weight between 0 and 100),
  active boolean not null default true,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  primary key (carousel_id, closer_id)
);

-- Livro-caixa: crédito (fatia de cada closer ativo a cada distribuição), débito (quem recebeu) e estorno.
-- Saldo = créditos − débitos + estornos, no período de equilíbrio (period_key).
create table painel.carousel_ledger (
  id bigint generated always as identity primary key,
  carousel_id uuid not null references painel.carousels,
  closer_id uuid not null references painel.sdrs,
  kind text not null check (kind in ('credit', 'debit', 'refund')),
  amount numeric not null,
  meeting_id uuid references painel.meetings on delete set null,
  period_key text not null,
  created_at timestamptz not null default now()
);
create index carousel_ledger_period_idx on painel.carousel_ledger (carousel_id, period_key, closer_id);
create index carousel_ledger_meeting_idx on painel.carousel_ledger (meeting_id);

-- Reuniões do painel: data, hora, closer e carrossel. Origem nova "painel".
alter table painel.meetings drop constraint meetings_source_check;
alter table painel.meetings add constraint meetings_source_check check (source in ('hubspot', 'manual', 'painel'));
alter table painel.meetings
  add column carousel_id uuid references painel.carousels,
  add column closer_id uuid references painel.sdrs,
  add column starts_at timestamptz,
  add column ends_at timestamptz,
  add column assigned_by text check (assigned_by in ('carrossel', 'manual')),
  add column created_by uuid,
  add column override_reason text,
  add constraint meetings_painel_chk check (source <> 'painel' or (closer_id is not null and starts_at is not null and ends_at > starts_at));
-- A marcação manual da Fase 6 continua uma por lead; reuniões do painel podem ser várias por lead.
drop index painel.meetings_lead_uidx;
create unique index meetings_lead_manual_uidx on painel.meetings (lead_id) where source = 'manual';
create index meetings_closer_time_idx on painel.meetings (closer_id, starts_at) where source = 'painel';

alter table painel.carousels enable row level security;
alter table painel.carousel_members enable row level security;
alter table painel.carousel_ledger enable row level security;
grant all on painel.carousels, painel.carousel_members, painel.carousel_ledger to service_role;
grant usage, select on all sequences in schema painel to service_role;

-- Gestor e admin cadastram carrosséis e pesos (tela Carrosséis). SDR não acessa.
grant select, insert, update on painel.carousels, painel.carousel_members to authenticated;
create policy carousels_manager on painel.carousels for all to authenticated
  using ((select painel.is_manager())) with check ((select painel.is_manager()));
create policy carousel_members_manager on painel.carousel_members for all to authenticated
  using ((select painel.is_manager())) with check ((select painel.is_manager()));

-- Quem mudou e quando.
create function painel.touch_updated()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  new.updated_by := (select auth.uid());
  return new;
end;
$$;
revoke execute on function painel.touch_updated() from public, anon, authenticated;

create trigger carousels_touch before insert or update on painel.carousels
  for each row execute function painel.touch_updated();
create trigger carousel_members_touch before insert or update on painel.carousel_members
  for each row execute function painel.touch_updated();

-- Configurações gerais do agendamento (decisões de 2026-10-07).
insert into painel.settings (key, value) values
  ('lunch_start', '"12:00"'),
  ('lunch_end', '"13:30"'),
  ('manual_min_time', '"07:00"'),
  ('manual_max_time', '"20:00"')
on conflict (key) do nothing;

-- Os 7 carrosséis de hoje (4 Poli, 3 ChatsHub). Os closers e pesos são cadastrados na tela.
insert into painel.carousels (brand, name, description, sort) values
  ('poli', 'Clientes até 5 usuários', 'Empresas que vão usar a Poli com até 5 usuários.', 1),
  ('poli', 'Clientes de 6 a 10 usuários', 'Empresas que vão usar a Poli com 6 a 10 usuários.', 2),
  ('poli', 'Acima de 10 usuários', 'Empresas que vão usar a Poli com mais de 10 usuários.', 3),
  ('poli', 'Licitação', 'Oportunidades de licitação.', 4),
  ('chatshub', 'Clientes até 5 usuários', 'Empresas que vão usar a ChatsHub com até 5 usuários.', 1),
  ('chatshub', 'Clientes de 6 a 10 usuários', 'Empresas que vão usar a ChatsHub com 6 a 10 usuários.', 2),
  ('chatshub', 'Acima de 10 usuários', 'Empresas que vão usar a ChatsHub com mais de 10 usuários.', 3);

-- Chave do período de equilíbrio no fuso de negócio: '2026-10' (mês) ou '2026-W41' (semana ISO).
create function painel.period_key(p_at timestamptz, p_period text)
returns text
language sql
stable
set search_path = ''
as $$
  select case when p_period = 'week'
              then to_char(p_at at time zone coalesce((select s.value #>> '{}' from painel.settings s where s.key = 'timezone'), 'America/Sao_Paulo'), 'IYYY-"W"IW')
              else to_char(p_at at time zone coalesce((select s.value #>> '{}' from painel.settings s where s.key = 'timezone'), 'America/Sao_Paulo'), 'YYYY-MM') end;
$$;

revoke execute on function painel.period_key(timestamptz, text) from public, anon, authenticated;
grant execute on function painel.period_key(timestamptz, text) to service_role;

-- O closer não tem reunião do painel no intervalo (com o intervalo mínimo entre reuniões, de qualquer carrossel).
create function painel.closer_livre_no_painel(p_closer uuid, p_starts timestamptz, p_ends timestamptz,
                                              p_gap_minutes integer, p_ignorar uuid default null)
returns boolean
language sql
stable
set search_path = ''
as $$
  select not exists (
    select 1 from painel.meetings m
    where m.source = 'painel' and m.closer_id = p_closer and m.status <> 'cancelada'
      and m.id is distinct from p_ignorar
      and m.starts_at < p_ends + make_interval(mins => p_gap_minutes)
      and m.ends_at > p_starts - make_interval(mins => p_gap_minutes)
  );
$$;

revoke execute on function painel.closer_livre_no_painel(uuid, timestamptz, timestamptz, integer, uuid) from public, anon, authenticated;
grant execute on function painel.closer_livre_no_painel(uuid, timestamptz, timestamptz, integer, uuid) to service_role;

-- Saldo de cada closer do carrossel no período.
create function painel.carousel_saldos(p_carousel uuid, p_period_key text)
returns table (closer_id uuid, creditos numeric, recebidas numeric, saldo numeric, ultima_recebida timestamptz)
language sql
stable
set search_path = ''
as $$
  select m.closer_id,
         coalesce(sum(l.amount) filter (where l.kind = 'credit'), 0),
         coalesce(sum(l.amount) filter (where l.kind = 'debit'), 0) - coalesce(sum(l.amount) filter (where l.kind = 'refund'), 0),
         coalesce(sum(l.amount) filter (where l.kind = 'credit'), 0)
           - coalesce(sum(l.amount) filter (where l.kind = 'debit'), 0)
           + coalesce(sum(l.amount) filter (where l.kind = 'refund'), 0),
         max(l.created_at) filter (where l.kind = 'debit')
  from painel.carousel_members m
  left join painel.carousel_ledger l
    on l.carousel_id = m.carousel_id and l.closer_id = m.closer_id and l.period_key = p_period_key
  where m.carousel_id = p_carousel
  group by m.closer_id;
$$;

revoke execute on function painel.carousel_saldos(uuid, text) from public, anon, authenticated;
grant execute on function painel.carousel_saldos(uuid, text) to service_role;

-- Reserva uma reunião: escolhe o closer pelo carrossel e grava a reunião e o livro-caixa, numa transação com trava.
-- p_livres = closers livres na agenda do Google no intervalo (na 10c vem do free/busy). Só o servidor chama.
-- Regras: lead preso ao mesmo closer por sticky_days; senão, entre os elegíveis e livres, maior saldo;
-- empate: quem recebeu há mais tempo (nunca recebeu = primeiro); depois, nome.
create function painel.reservar_reuniao(
  p_carousel uuid,
  p_lead uuid,
  p_starts timestamptz,
  p_ends timestamptz,
  p_livres uuid[],
  p_sdr uuid default null,
  p_created_by uuid default null
)
returns table (meeting_id uuid, closer_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  c painel.carousels;
  v_period text;
  v_sticky uuid;
  v_closer uuid;
  v_meeting uuid;
  v_total numeric;
begin
  -- uma distribuição por vez (a agenda do closer é compartilhada entre carrosséis)
  perform pg_advisory_xact_lock(hashtext('painel.agendamento'));

  select * into c from painel.carousels where id = p_carousel and active;
  if c.id is null then
    raise exception 'carrossel inexistente ou arquivado' using errcode = 'P0002';
  end if;
  if p_lead is null or p_ends <= p_starts then
    raise exception 'lead e horário são obrigatórios' using errcode = '22023';
  end if;
  v_period := painel.period_key(now(), c.balance_period);

  -- elegíveis: ativos no carrossel, peso > 0, closer ativo
  create temp table if not exists _eleg (closer_id uuid, weight integer, name text) on commit drop;
  truncate _eleg;
  insert into _eleg
  select m.closer_id, m.weight, s.name
  from painel.carousel_members m join painel.sdrs s on s.id = m.closer_id
  where m.carousel_id = p_carousel and m.active and m.weight > 0 and s.active;

  -- lead preso ao closer da última reunião dele (dentro de sticky_days), se o closer ainda está no carrossel
  if c.sticky_days > 0 then
    select pm.closer_id into v_sticky
    from painel.meetings pm
    where pm.lead_id = p_lead and pm.source = 'painel'
      and pm.created_at >= now() - make_interval(days => c.sticky_days)
    order by pm.created_at desc
    limit 1;
    if v_sticky is not null and not exists (select 1 from _eleg e where e.closer_id = v_sticky) then
      v_sticky := null;
    end if;
  end if;

  if v_sticky is not null then
    if v_sticky = any (coalesce(p_livres, '{}')) and painel.closer_livre_no_painel(v_sticky, p_starts, p_ends, c.gap_minutes) then
      v_closer := v_sticky;
    else
      raise exception 'o closer deste lead não está livre neste horário' using errcode = 'P0001', hint = 'closer_do_lead_ocupado';
    end if;
  else
    select e.closer_id into v_closer
    from _eleg e
    left join painel.carousel_saldos(p_carousel, v_period) s on s.closer_id = e.closer_id
    where e.closer_id = any (coalesce(p_livres, '{}'))
      and painel.closer_livre_no_painel(e.closer_id, p_starts, p_ends, c.gap_minutes)
    order by coalesce(s.saldo, 0) desc, s.ultima_recebida asc nulls first, e.name asc, e.closer_id asc
    limit 1;
    if v_closer is null then
      raise exception 'nenhum closer livre neste horário' using errcode = 'P0001', hint = 'sem_closer_livre';
    end if;
  end if;

  insert into painel.meetings (lead_id, sdr_id, status, source, carousel_id, closer_id, starts_at, ends_at,
                               assigned_by, created_by, status_changed_at)
  values (p_lead, p_sdr, 'agendada', 'painel', p_carousel, v_closer, p_starts, p_ends,
          'carrossel', p_created_by, now())
  returning id into v_meeting;

  -- créditos: a fatia de cada closer ativo no momento (livre ou não); débito: quem recebeu
  select sum(weight) into v_total from _eleg;
  insert into painel.carousel_ledger (carousel_id, closer_id, kind, amount, meeting_id, period_key)
  select p_carousel, e.closer_id, 'credit', e.weight::numeric / v_total, v_meeting, v_period from _eleg e;
  insert into painel.carousel_ledger (carousel_id, closer_id, kind, amount, meeting_id, period_key)
  values (p_carousel, v_closer, 'debit', 1, v_meeting, v_period);

  return query select v_meeting, v_closer;
end;
$$;
revoke execute on function painel.reservar_reuniao(uuid, uuid, timestamptz, timestamptz, uuid[], uuid, uuid) from public, anon, authenticated;
grant execute on function painel.reservar_reuniao(uuid, uuid, timestamptz, timestamptz, uuid[], uuid, uuid) to service_role;

-- Desfaz uma reserva (ex.: a criação do evento no Google falhou). Apaga a reunião e os lançamentos dela.
create function painel.desfazer_reserva(p_meeting uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtext('painel.agendamento'));
  delete from painel.carousel_ledger where meeting_id = p_meeting;
  delete from painel.meetings where id = p_meeting and source = 'painel';
end;
$$;
revoke execute on function painel.desfazer_reserva(uuid) from public, anon, authenticated;
grant execute on function painel.desfazer_reserva(uuid) to service_role;

-- Estorno: quando uma reunião do painel vira no show / cancelada / invalidada, o débito do closer é estornado
-- conforme as regras do carrossel. Se a situação voltar atrás, o estorno é desfeito. Idempotente.
create function painel.meetings_estorno()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  c painel.carousels;
  v_should boolean;
  v_has numeric;
  v_period text;
  v_car uuid;
  v_clo uuid;
begin
  if new.source <> 'painel' or new.carousel_id is null or new.status is not distinct from old.status then
    return new;
  end if;
  select * into c from painel.carousels where id = new.carousel_id;
  v_should := (new.status = 'noshow' and c.refund_noshow)
           or (new.status = 'cancelada' and c.refund_cancelada)
           or (new.status = 'invalidada' and c.refund_invalidada);
  -- vale o lançamento vigente da reunião (o débito mais recente; ela pode ter sido relançada)
  select l.carousel_id, l.closer_id, l.period_key into v_car, v_clo, v_period
  from painel.carousel_ledger l
  where l.meeting_id = new.id and l.kind = 'debit' and l.amount > 0
  order by l.id desc limit 1;
  if v_period is null then
    return new;
  end if;
  select coalesce(sum(amount), 0) into v_has from painel.carousel_ledger
  where meeting_id = new.id and kind = 'refund' and carousel_id = v_car and closer_id = v_clo and period_key = v_period;
  if v_should and v_has <= 0 then
    insert into painel.carousel_ledger (carousel_id, closer_id, kind, amount, meeting_id, period_key)
    values (v_car, v_clo, 'refund', 1, new.id, v_period);
  elsif not v_should and v_has > 0 then
    insert into painel.carousel_ledger (carousel_id, closer_id, kind, amount, meeting_id, period_key)
    values (v_car, v_clo, 'refund', -1, new.id, v_period);
  end if;
  return new;
end;
$$;
revoke execute on function painel.meetings_estorno() from public, anon, authenticated;

create trigger meetings_estorno after update of status on painel.meetings
  for each row execute function painel.meetings_estorno();


-- Refaz os lançamentos de uma reunião que mudou de closer e/ou de carrossel: anula os lançamentos antigos
-- (valores negativos, mantendo o histórico) e lança de novo no carrossel atual, com a fatia dos ativos de agora.
-- Uso interno (reagendar, trocar closer, trocar de carrossel).
create function painel._relancar_reuniao(p_meeting uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  m painel.meetings;
  c painel.carousels;
  v_period text;
  v_total numeric;
begin
  select * into m from painel.meetings where id = p_meeting;
  select * into c from painel.carousels where id = m.carousel_id;
  -- anula tudo o que esta reunião lançou até aqui (cada linha com o valor oposto, no mesmo período)
  insert into painel.carousel_ledger (carousel_id, closer_id, kind, amount, meeting_id, period_key)
  select l.carousel_id, l.closer_id, l.kind, -sum(l.amount), p_meeting, l.period_key
  from painel.carousel_ledger l
  where l.meeting_id = p_meeting
  group by l.carousel_id, l.closer_id, l.kind, l.period_key
  having sum(l.amount) <> 0;
  -- lança de novo no carrossel atual
  v_period := painel.period_key(now(), c.balance_period);
  select sum(cm.weight) into v_total
  from painel.carousel_members cm join painel.sdrs s on s.id = cm.closer_id
  where cm.carousel_id = c.id and cm.active and cm.weight > 0 and s.active;
  if v_total > 0 then
    insert into painel.carousel_ledger (carousel_id, closer_id, kind, amount, meeting_id, period_key)
    select c.id, cm.closer_id, 'credit', cm.weight::numeric / v_total, p_meeting, v_period
    from painel.carousel_members cm join painel.sdrs s on s.id = cm.closer_id
    where cm.carousel_id = c.id and cm.active and cm.weight > 0 and s.active;
  end if;
  insert into painel.carousel_ledger (carousel_id, closer_id, kind, amount, meeting_id, period_key)
  values (c.id, m.closer_id, 'debit', 1, p_meeting, v_period);
  -- se a reunião está numa situação que devolve a vez, o estorno vale também no lançamento novo
  if (m.status = 'noshow' and c.refund_noshow) or (m.status = 'cancelada' and c.refund_cancelada)
     or (m.status = 'invalidada' and c.refund_invalidada) then
    insert into painel.carousel_ledger (carousel_id, closer_id, kind, amount, meeting_id, period_key)
    values (c.id, m.closer_id, 'refund', 1, p_meeting, v_period);
  end if;
end;
$$;
revoke execute on function painel._relancar_reuniao(uuid) from public, anon, authenticated;

-- Editar (mesmo dia) e Reagendar (outro dia): muda o horário da mesma reunião. Tenta o mesmo closer; se ele
-- não estiver livre (no Google e no painel), o carrossel escolhe outro entre os livres, às cegas, e o
-- livro-caixa é refeito. Reunião cancelada volta a "agendada". Só o servidor chama (decisões de 2026-10-07).
create function painel.reagendar_reuniao(p_meeting uuid, p_starts timestamptz, p_ends timestamptz, p_livres uuid[])
returns table (closer_id uuid, closer_mudou boolean)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
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
  if p_ends <= p_starts then
    raise exception 'horário inválido' using errcode = '22023';
  end if;
  select * into c from painel.carousels where id = m.carousel_id;

  if m.closer_id = any (coalesce(p_livres, '{}'))
     and painel.closer_livre_no_painel(m.closer_id, p_starts, p_ends, c.gap_minutes, p_meeting) then
    v_closer := m.closer_id;
  else
    select e.closer_id into v_closer
    from painel.carousel_members e
    join painel.sdrs sd on sd.id = e.closer_id
    left join painel.carousel_saldos(c.id, painel.period_key(now(), c.balance_period)) b on b.closer_id = e.closer_id
    where e.carousel_id = c.id and e.active and e.weight > 0 and sd.active
      and e.closer_id = any (coalesce(p_livres, '{}'))
      and painel.closer_livre_no_painel(e.closer_id, p_starts, p_ends, c.gap_minutes, p_meeting)
    order by coalesce(b.saldo, 0) desc, b.ultima_recebida asc nulls first, sd.name asc, e.closer_id asc
    limit 1;
    if v_closer is null then
      raise exception 'nenhum closer livre neste horário' using errcode = 'P0001', hint = 'sem_closer_livre';
    end if;
  end if;

  update painel.meetings
     set starts_at = p_starts, ends_at = p_ends, closer_id = v_closer,
         assigned_by = case when v_closer = m.closer_id then m.assigned_by else 'carrossel' end,
         status = case when m.status = 'cancelada' then 'agendada' else m.status end,
         status_changed_at = case when m.status = 'cancelada' then now() else m.status_changed_at end
   where id = p_meeting;
  if v_closer <> m.closer_id then
    perform painel._relancar_reuniao(p_meeting);
  end if;
  return query select v_closer, v_closer <> m.closer_id;
end;
$$;
revoke execute on function painel.reagendar_reuniao(uuid, timestamptz, timestamptz, uuid[]) from public, anon, authenticated;
grant execute on function painel.reagendar_reuniao(uuid, timestamptz, timestamptz, uuid[]) to service_role;

-- Troca de closer decidida por gestor/admin (direta ou aprovando pedido do SDR). O novo closer precisa estar
-- livre (p_livres = livres no Google). Livro-caixa refeito; motivo registrado. Só o servidor chama.
create function painel.trocar_closer(p_meeting uuid, p_novo_closer uuid, p_livres uuid[], p_motivo text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  m painel.meetings;
  c painel.carousels;
begin
  perform pg_advisory_xact_lock(hashtext('painel.agendamento'));
  select * into m from painel.meetings where id = p_meeting and source = 'painel';
  if m.id is null then
    raise exception 'reunião não encontrada' using errcode = 'P0002';
  end if;
  if p_novo_closer = m.closer_id then
    return;
  end if;
  select * into c from painel.carousels where id = m.carousel_id;
  if not (p_novo_closer = any (coalesce(p_livres, '{}')))
     or not painel.closer_livre_no_painel(p_novo_closer, m.starts_at, m.ends_at, c.gap_minutes, p_meeting) then
    raise exception 'o closer escolhido não está livre neste horário' using errcode = 'P0001', hint = 'closer_ocupado';
  end if;
  update painel.meetings
     set closer_id = p_novo_closer, assigned_by = 'manual', override_reason = nullif(trim(p_motivo), '')
   where id = p_meeting;
  perform painel._relancar_reuniao(p_meeting);
end;
$$;
revoke execute on function painel.trocar_closer(uuid, uuid, uuid[], text) from public, anon, authenticated;
grant execute on function painel.trocar_closer(uuid, uuid, uuid[], text) to service_role;

-- "Passar para CH" / "Passar para Poli": a reunião vai para o carrossel de mesmo porte na outra marca, com o
-- mesmo closer e horário; o livro-caixa sai do carrossel antigo e vai para o novo (decisão de 2026-10-07).
create function painel.trocar_carrossel(p_meeting uuid, p_novo_carrossel uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  m painel.meetings;
begin
  perform pg_advisory_xact_lock(hashtext('painel.agendamento'));
  select * into m from painel.meetings where id = p_meeting and source = 'painel';
  if m.id is null then
    raise exception 'reunião não encontrada' using errcode = 'P0002';
  end if;
  if not exists (select 1 from painel.carousels where id = p_novo_carrossel and active) then
    raise exception 'carrossel inexistente ou arquivado' using errcode = 'P0002';
  end if;
  if p_novo_carrossel = m.carousel_id then
    return;
  end if;
  update painel.meetings set carousel_id = p_novo_carrossel where id = p_meeting;
  perform painel._relancar_reuniao(p_meeting);
end;
$$;
revoke execute on function painel.trocar_carrossel(uuid, uuid) from public, anon, authenticated;
grant execute on function painel.trocar_carrossel(uuid, uuid) to service_role;

-- Tela Carrosséis (admin e gestor): closers do carrossel com peso, fatia, recebidas, esperado e saldo no período.
create function painel.carrossel_resumo(p_carousel uuid, p_period_key text default null)
returns table (closer_id uuid, name text, weight integer, active boolean, fatia numeric,
               recebidas numeric, esperado numeric, saldo numeric)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  c painel.carousels;
  v_period text;
begin
  if not painel.is_manager() then
    raise exception 'acesso negado' using errcode = '42501';
  end if;
  select * into c from painel.carousels where id = p_carousel;
  v_period := coalesce(p_period_key, painel.period_key(now(), c.balance_period));
  return query
  select m.closer_id, s.name, m.weight, m.active,
         case when m.active and m.weight > 0
              then round(m.weight::numeric / nullif(sum(m.weight) filter (where m.active and m.weight > 0) over (), 0), 4) end,
         coalesce(b.recebidas, 0), round(coalesce(b.creditos, 0), 2), round(coalesce(b.saldo, 0), 2)
  from painel.carousel_members m
  join painel.sdrs s on s.id = m.closer_id
  left join painel.carousel_saldos(p_carousel, v_period) b on b.closer_id = m.closer_id
  where m.carousel_id = p_carousel
  order by m.active desc, s.name;
end;
$$;
revoke execute on function painel.carrossel_resumo(uuid, text) from public, anon;
grant execute on function painel.carrossel_resumo(uuid, text) to authenticated, service_role;

-- Closers disponíveis para pôr num carrossel (tela Carrosséis; admin e gestor).
create function painel.closers_para_carrossel()
returns table (id uuid, name text, email text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not painel.is_manager() then
    raise exception 'acesso negado' using errcode = '42501';
  end if;
  return query select s.id, s.name, s.poli_email from painel.sdrs s where s.role = 'closer' and s.active order by s.name;
end;
$$;
revoke execute on function painel.closers_para_carrossel() from public, anon;
grant execute on function painel.closers_para_carrossel() to authenticated, service_role;

-- Carrosséis que o SDR escolhe ao agendar. Só nome e regras de duração: nenhuma informação de closer.
create function painel.carrosseis_para_agendar()
returns table (id uuid, brand text, name text, description text, durations integer[])
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform painel.escopo_sdr();   -- qualquer usuário ativo (SDR, gestor, admin); senão, acesso negado
  return query
  select c.id, c.brand::text, c.name, c.description, c.durations
  from painel.carousels c where c.active
  order by c.brand, c.sort, c.name;
end;
$$;
revoke execute on function painel.carrosseis_para_agendar() from public, anon;
grant execute on function painel.carrosseis_para_agendar() to authenticated, service_role;

-- Marcação manual da Fase 6 continua uma por lead (índice parcial em source = 'manual').
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
  if not painel.is_manager() then   -- marcar reunião à mão: admin e gestor (decisão de 2026-10-07)
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

-- Reunião atual do lead: marcação manual; senão, a reunião mais recente agendada pelo painel; senão, o HubSpot.
create or replace function painel.reuniao_do_lead(p_lead uuid, p_hubspot_contact_id text, out status text, out origem text)
language sql
stable
set search_path = ''
as $$
  select coalesce(m.status::text, pm.status::text, case when hs.agendou then 'agendada' end),
         case when m.status is not null then 'manual' when pm.status is not null then 'painel' when hs.agendou then 'hubspot' end
  from (select 1) x
  left join painel.meetings m on m.lead_id = p_lead and m.source = 'manual'
  left join lateral (
    -- reunião mais recente agendada pelo painel (Fase 10)
    select pm.status from painel.meetings pm
    where pm.lead_id = p_lead and pm.source = 'painel'
    order by pm.starts_at desc nulls last, pm.created_at desc
    limit 1
  ) pm on true
  left join lateral (
    select h.entered_agendado_at is not null as agendou
    from painel.hubspot_leads h
    where p_hubspot_contact_id is not null and h.hubspot_contact_id = p_hubspot_contact_id
    order by h.created_at desc nulls last, h.hubspot_lead_id desc
    limit 1
  ) hs on true;
$$;
