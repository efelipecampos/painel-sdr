-- Fase 10d.2: tela Reuniões, status da reunião do painel e mudança de horário (docs/agendamento.md, seções 2, 4 e 5).
-- Quem vê: o SDR as dele (que ele agendou ou de que é o SDR), o closer as dele, gestor e admin todas.
-- Status: closer da reunião, gestor e admin marcam qualquer um; o SDR só confirma "Cancelada" (lead desistiu
-- ou recusou no Google). Mudar horário: o SDR da reunião, gestor e admin. Tudo fica registrado.

-- Histórico de mudanças de horário e de closer (o de status já existe em meeting_status_history).
create table painel.meeting_changes (
  id bigint generated always as identity primary key,
  meeting_id uuid not null references painel.meetings on delete cascade,
  changed_at timestamptz not null default now(),
  changed_by uuid references painel.profiles,
  from_starts timestamptz,
  to_starts timestamptz,
  from_closer uuid references painel.sdrs,
  to_closer uuid references painel.sdrs
);
create index meeting_changes_meeting_idx on painel.meeting_changes (meeting_id, changed_at);
alter table painel.meeting_changes enable row level security;
grant all on painel.meeting_changes to service_role;

-- O que o usuário logado pode fazer com uma reunião do painel: null = nem ver.
create function painel.permissao_reuniao(p_id uuid)
returns text  -- 'gestor' | 'closer' | 'sdr'
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p.role in ('admin', 'gestor') then 'gestor'
    when p.role = 'closer' and m.closer_id = p.sdr_id then 'closer'
    when p.role = 'sdr' and (m.sdr_id = p.sdr_id or m.created_by = p.id) then 'sdr'
  end
  from painel.profiles p
  join painel.meetings m on m.id = p_id and m.source = 'painel'
  where p.id = (select auth.uid()) and p.active;
$$;
revoke execute on function painel.permissao_reuniao(uuid) from public, anon;
grant execute on function painel.permissao_reuniao(uuid) to authenticated, service_role;

-- Lista da tela Reuniões, por início da reunião no período [de, até).
create function painel.reunioes_lista(p_from timestamptz, p_to timestamptz)
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
         or (v_role = 'sdr' and (m.sdr_id = v_sdr or m.created_by = v_uid)))
  order by m.starts_at;
end;
$$;
revoke execute on function painel.reunioes_lista(timestamptz, timestamptz) from public, anon;
grant execute on function painel.reunioes_lista(timestamptz, timestamptz) to authenticated, service_role;

-- Marca o status de uma reunião do painel. O estorno do carrossel é feito pelo gatilho meetings_estorno.
-- Devolve o status anterior (o servidor usa para mover o evento para o arquivo ou de volta).
create function painel.definir_status_reuniao(p_id uuid, p_status text)
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
  if v_perm = 'sdr' and p_status <> 'cancelada' then
    raise exception 'o SDR só pode confirmar o cancelamento' using errcode = '42501';
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
revoke execute on function painel.definir_status_reuniao(uuid, text) from public, anon;
grant execute on function painel.definir_status_reuniao(uuid, text) to authenticated, service_role;
