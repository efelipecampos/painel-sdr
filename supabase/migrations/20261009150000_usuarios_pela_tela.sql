-- Tela Usuários (Fase 10, 2026-10-09): adicionar usuário (convite por e-mail) e trocar papel pela tela.
-- O papel definido na tela vale mais que as listas POLI_SDR_EMAILS/POLI_CLOSER_EMAILS do .env: o worker só usa
-- as listas para quem nunca teve o papel definido na tela.

alter table painel.sdrs add column role_pela_tela boolean not null default false;

-- Papel do atendente (painel.sdrs) que corresponde ao papel do login. Admin fica como gestor no atendente.
create function painel.papel_atendente(p_papel text)
returns painel.team_role
language sql
immutable
set search_path = ''
as $$
  select (case when p_papel in ('sdr', 'closer') then p_papel else 'gestor' end)::painel.team_role;
$$;
revoke execute on function painel.papel_atendente(text) from public, anon, authenticated;

-- Atendente do e-mail (cria se ainda não existe), já com o papel da tela.
create function painel.atendente_do_email(p_email text, p_nome text, p_papel text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  select s.id into v_id from painel.sdrs s where lower(s.poli_email) = lower(p_email);
  if v_id is null then
    insert into painel.sdrs (poli_email, email, name, role, role_pela_tela)
    values (lower(p_email), lower(p_email), p_nome, painel.papel_atendente(p_papel), true)
    returning id into v_id;
  else
    update painel.sdrs set role = painel.papel_atendente(p_papel), role_pela_tela = true, active = true where id = v_id;
  end if;
  return v_id;
end;
$$;
revoke execute on function painel.atendente_do_email(text, text, text) from public, anon, authenticated;

-- Usuário novo: chamado pelo servidor (service_role) depois de criar o login no Supabase Auth (convite).
-- O servidor confere antes quem está pedindo (admin ou quem tem a marcação; admin novo só por admin).
create function painel.cadastrar_usuario(p_user uuid, p_nome text, p_papel text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text;
  v_sdr uuid;
begin
  if p_papel not in ('admin', 'gestor', 'sdr', 'closer') then
    raise exception 'papel inválido' using errcode = 'P0001';
  end if;
  if coalesce(trim(p_nome), '') = '' then
    raise exception 'falta o nome' using errcode = 'P0001';
  end if;
  select lower(u.email) into v_email from auth.users u where u.id = p_user;
  if v_email is null then
    raise exception 'login não encontrado' using errcode = 'P0001';
  end if;
  if exists (select 1 from painel.profiles p where p.id = p_user and p.active) then
    raise exception 'essa pessoa já tem acesso ao painel' using errcode = 'P0001';
  end if;
  v_sdr := painel.atendente_do_email(v_email, trim(p_nome), p_papel);
  insert into painel.profiles (id, name, role, sdr_id, active)
  values (p_user, trim(p_nome), p_papel::painel.app_role, case when p_papel in ('sdr', 'closer') then v_sdr end, true)
  on conflict (id) do update set name = excluded.name, role = excluded.role, sdr_id = excluded.sdr_id, active = true;
end;
$$;
revoke execute on function painel.cadastrar_usuario(uuid, text, text) from public, anon, authenticated;
grant execute on function painel.cadastrar_usuario(uuid, text, text) to service_role;

-- Login (id) de um e-mail, para quando o convite falha porque o e-mail já existe no Supabase Auth.
create function painel.login_do_email(p_email text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select u.id from auth.users u where lower(u.email) = lower(trim(p_email)) limit 1;
$$;
revoke execute on function painel.login_do_email(text) from public, anon, authenticated;
grant execute on function painel.login_do_email(text) to service_role;

-- Trocar papel pela tela, com a sessão de quem pede. Não muda o próprio papel; admin só por admin.
create function painel.definir_papel(p_sdr uuid, p_profile uuid, p_papel text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin boolean := exists (select 1 from painel.profiles p where p.id = (select auth.uid()) and p.active and p.role = 'admin');
  v_atual text;
  v_email text;
  v_nome text;
  v_sdr uuid := p_sdr;
begin
  if not painel.pode_gerenciar_usuarios() then
    raise exception 'acesso negado' using errcode = '42501';
  end if;
  if p_papel not in ('admin', 'gestor', 'sdr', 'closer') then
    raise exception 'papel inválido' using errcode = 'P0001';
  end if;
  if p_profile = (select auth.uid()) then
    raise exception 'você não pode mudar o próprio papel' using errcode = 'P0001';
  end if;
  select p.role::text, lower(u.email), p.name into v_atual, v_email, v_nome
  from painel.profiles p join auth.users u on u.id = p.id where p.id = p_profile;
  if (v_atual = 'admin' or p_papel = 'admin') and not v_admin then
    raise exception 'só o administrador muda o papel de admin' using errcode = 'P0001';
  end if;
  if p_profile is null and p_papel = 'admin' then
    raise exception 'para ser admin, a pessoa precisa de login no painel' using errcode = 'P0001';
  end if;
  if p_profile is null and v_sdr is null then
    raise exception 'usuário não encontrado' using errcode = 'P0001';
  end if;

  if v_sdr is not null then
    if exists (select 1 from painel.sdrs s where s.id = v_sdr and s.is_bot) then
      raise exception 'robô não tem papel' using errcode = 'P0001';
    end if;
    update painel.sdrs set role = painel.papel_atendente(p_papel), role_pela_tela = true where id = v_sdr;
  elsif p_papel in ('sdr', 'closer') then
    -- login sem atendente (ex.: gestor que vira SDR): liga a um atendente pelo e-mail
    v_sdr := painel.atendente_do_email(v_email, v_nome, p_papel);
  end if;

  if p_profile is not null then
    update painel.profiles
    set role = p_papel::painel.app_role, sdr_id = case when p_papel in ('sdr', 'closer') then v_sdr end
    where id = p_profile;
  end if;
end;
$$;
revoke execute on function painel.definir_papel(uuid, uuid, text) from public, anon;
grant execute on function painel.definir_papel(uuid, uuid, text) to authenticated, service_role;
