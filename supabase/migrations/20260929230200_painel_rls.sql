-- Privilégios e regras de acesso (docs/spec.md, seção 3 → RLS).
--
-- service_role (worker do painel e API routes): acesso total ao schema painel. Ignora RLS.
-- authenticated (navegador): só o que a tela usa. Nesta fase: o próprio perfil e as
--   tabelas de configuração. Leitura para usuário ativo; escrita só para admin.
--   As métricas chegam por funções RPC (Fase 4), não por leitura direta das tabelas.
-- anon: nada.

-- Garantia extra: ninguém além do service_role acessa as tabelas da integração.
revoke all on public.messages, public.raw_events from anon, authenticated;

-- Funções não são executáveis por PUBLIC por padrão neste schema.
alter default privileges in schema painel revoke execute on functions from public;

grant usage on schema painel to service_role, authenticated;

grant all on all tables in schema painel to service_role;
grant usage, select on all sequences in schema painel to service_role;
-- Tabelas, sequências e funções criadas por migrations futuras também ficam com o service_role.
alter default privileges in schema painel grant all on tables to service_role;
alter default privileges in schema painel grant usage, select on sequences to service_role;
alter default privileges in schema painel grant execute on functions to service_role;

-- Funções auxiliares das policies. security definer para ler profiles sem depender
-- das policies da própria tabela.
create function painel.is_active_user()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from painel.profiles p
    where p.id = (select auth.uid()) and p.active
  );
$$;

create function painel.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from painel.profiles p
    where p.id = (select auth.uid()) and p.active and p.role = 'admin'
  );
$$;

revoke execute on function painel.is_active_user(), painel.is_admin() from public, anon;
grant execute on function painel.is_active_user(), painel.is_admin() to authenticated, service_role;

-- profiles: cada usuário ativo lê o próprio perfil; admin lê todos.
-- Cadastro e edição de usuários ficam com o servidor (service_role) na Fase 5.
grant select on painel.profiles to authenticated;
create policy profiles_select on painel.profiles
  for select to authenticated
  using ((id = (select auth.uid()) and active) or (select painel.is_admin()));

-- Tabelas de configuração: leitura para usuário ativo, escrita só para admin.
grant select, insert, update, delete on
  painel.business_hours, painel.holidays, painel.settings, painel.quality_criteria
  to authenticated;

create policy business_hours_select on painel.business_hours
  for select to authenticated using ((select painel.is_active_user()));
create policy business_hours_write on painel.business_hours
  for all to authenticated
  using ((select painel.is_admin())) with check ((select painel.is_admin()));

create policy holidays_select on painel.holidays
  for select to authenticated using ((select painel.is_active_user()));
create policy holidays_write on painel.holidays
  for all to authenticated
  using ((select painel.is_admin())) with check ((select painel.is_admin()));

create policy settings_select on painel.settings
  for select to authenticated using ((select painel.is_active_user()));
create policy settings_write on painel.settings
  for all to authenticated
  using ((select painel.is_admin())) with check ((select painel.is_admin()));

create policy quality_criteria_select on painel.quality_criteria
  for select to authenticated using ((select painel.is_active_user()));
create policy quality_criteria_write on painel.quality_criteria
  for all to authenticated
  using ((select painel.is_admin())) with check ((select painel.is_admin()));

-- Demais tabelas (sdrs, leads, chats, chat_owner_history, chat_messages, response_events,
-- lead_scores, meetings, meeting_status_history): RLS ligado, sem GRANT e sem policy para
-- authenticated. Só o service_role lê e escreve. A tela recebe os dados pelas RPCs.
