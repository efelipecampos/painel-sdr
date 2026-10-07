-- Fase 10c (2/2): Google Agenda (docs/agendamento.md, seção 6). Caminho B: cada closer conecta a própria agenda
-- pelo botão na tela dele. A autorização fica cifrada (chave só no servidor). Usuários do painel não acessam
-- as tabelas novas; só o servidor (service_role).

-- Perfil de closer também é ligado ao atendente (painel.sdrs). Papel sdr/closer <=> sdr_id preenchido.
alter table painel.profiles drop constraint profiles_sdr_id_chk;
alter table painel.profiles add constraint profiles_sdr_id_chk check ((role in ('sdr', 'closer')) = (sdr_id is not null));

-- Conexão da agenda de cada closer.
create table painel.google_connections (
  closer_id uuid primary key references painel.sdrs,
  google_email text not null,
  refresh_token_enc text not null,          -- cifrado (AES-256-GCM) no servidor; o banco nunca vê o texto aberto
  scopes text[] not null,
  status text not null default 'conectada' check (status in ('conectada', 'desconectada')),
  connected_at timestamptz not null default now(),
  last_ok_at timestamptz,
  last_error text,                          -- motivo devolvido pelo Google (ex.: invalid_grant), sem dado de lead
  updated_at timestamptz not null default now()
);

-- Registro de toda chamada à agenda que falhou (e das que deram certo na tela de teste e na conexão).
-- Decisão de 2026-10-07: toda falha de agenda com horário, closer e a resposta do Google. Sem dado de lead.
create table painel.calendar_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  closer_id uuid references painel.sdrs,
  meeting_id uuid references painel.meetings on delete set null,
  op text not null,                         -- conectar | autorizar | livre_ocupado | criar | alterar | mover | ler | apagar
  ok boolean not null,
  http_status integer,
  reason text
);
create index calendar_log_at_idx on painel.calendar_log (at desc);

-- Evento do Google de cada reunião do painel.
alter table painel.meetings
  add column google_calendar_id text,      -- agenda onde o evento está agora (primary do closer ou o arquivo)
  add column google_event_id text,
  add column meet_url text,
  add column google_state text check (google_state in ('ok', 'removida', 'recusada_lead', 'recusada_closer')),
  add column google_checked_at timestamptz;

alter table painel.google_connections enable row level security;
alter table painel.calendar_log enable row level security;
grant all on painel.google_connections, painel.calendar_log to service_role;
grant usage, select on all sequences in schema painel to service_role;

-- Agenda de arquivo (conta do Felipe, compartilhada com os closers) e SDR como convidado.
insert into painel.settings (key, value) values
  ('google_archive_calendar_id', '""'),
  ('google_invite_sdr', 'true')
on conflict (key) do nothing;

-- Situação da agenda do próprio closer (tela do closer). Nunca devolve o token.
create function painel.minha_agenda_google()
returns table (google_email text, status text, connected_at timestamptz, last_error text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_sdr uuid;
begin
  select p.sdr_id into v_sdr from painel.profiles p
  where p.id = (select auth.uid()) and p.active and p.role = 'closer';
  if v_sdr is null then
    raise exception 'acesso negado' using errcode = '42501';
  end if;
  return query select g.google_email, g.status, g.connected_at, g.last_error
               from painel.google_connections g where g.closer_id = v_sdr;
end;
$$;
revoke execute on function painel.minha_agenda_google() from public, anon;
grant execute on function painel.minha_agenda_google() to authenticated, service_role;

-- Tela Usuários: mesma lista, com a situação da agenda dos closers (conectada | desconectada | nao_conectada).
drop function painel.usuarios();
create function painel.usuarios()
returns table (sdr_id uuid, profile_id uuid, name text, email text, papel text, is_bot boolean, tem_login boolean, active boolean,
               agenda text)
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
         s.profile_id is not null, s.active and coalesce(p.active, true),
         case when s.role = 'closer' then coalesce(g.status, 'nao_conectada') end
  from s left join p on p.id = s.profile_id
  left join painel.google_connections g on g.closer_id = s.id
  union all
  select null::uuid, p.id, p.name, p.email, p.role, false, true, p.active, null::text
  from p where not exists (select 1 from s where s.profile_id = p.id)
  order by 8 desc, 3;
end;
$$;
revoke execute on function painel.usuarios() from public, anon;
grant execute on function painel.usuarios() to authenticated, service_role;
