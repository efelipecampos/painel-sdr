-- Fase 10d.1: o SDR agenda pelo painel (docs/agendamento.md, seções 4 e 5).
-- Dados da reunião vindos do HubSpot na hora, passagem de bastão, lead sem chat (plano B pelo link do HubSpot),
-- carrossel sugerido pelo número de usuários e as funções de leitura das telas (com a checagem de papel no banco).
-- Correção da 10b, conforme a especificação: closer sem agenda do Google conectada não acumula crédito.

-- Lead que ainda não tem chat no painel (agendado pelo link do HubSpot): não tem contato da Poli.
alter table painel.leads alter column poli_contact_uuid drop not null;

-- Dados da reunião do painel. Dado pessoal do lead (nome, empresa, e-mail) só o necessário para o convite,
-- o reagendamento e as listas. A passagem de bastão fica só aqui (não vai na descrição do evento).
alter table painel.meetings
  add column lead_name text,
  add column company text,
  add column lead_email text,
  add column hubspot_contact_id text,
  add column hubspot_lead_id text,
  add column title text,
  add column handoff text,
  add column fora_do_padrao boolean not null default false;  -- ajuste manual fora do expediente padrão
create index meetings_hubspot_contact_idx on painel.meetings (hubspot_contact_id) where hubspot_contact_id is not null;

-- Carrossel sugerido pelo número de usuários (propriedade sdr_2_0__quantidade_de_usuarios_a_utilizar_a_plataforma).
alter table painel.carousels add column suggest_min_users integer, add column suggest_max_users integer;
update painel.carousels set suggest_min_users = null, suggest_max_users = 5 where name = 'Clientes até 5 usuários';
update painel.carousels set suggest_min_users = 6, suggest_max_users = 10 where name = 'Clientes de 6 a 10 usuários';
update painel.carousels set suggest_min_users = 11, suggest_max_users = null where name = 'Acima de 10 usuários';

create or replace function painel.reservar_reuniao(
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

  -- elegíveis: ativos no carrossel, peso > 0, closer ativo, agenda do Google conectada
  create temp table if not exists _eleg (closer_id uuid, weight integer, name text) on commit drop;
  truncate _eleg;
  insert into _eleg
  select m.closer_id, m.weight, s.name
  from painel.carousel_members m join painel.sdrs s on s.id = m.closer_id
  where m.carousel_id = p_carousel and m.active and m.weight > 0 and s.active
    and exists (select 1 from painel.google_connections g where g.closer_id = m.closer_id and g.status = 'conectada');  -- sem agenda conectada não acumula crédito

  -- lead preso ao closer da última reunião dele (dentro de sticky_days), se o closer ainda está no carrossel
  if c.sticky_days > 0 then
    select pm.closer_id into v_sticky
    from painel.meetings pm
    where pm.source = 'painel'
      and (pm.lead_id = p_lead
           or pm.hubspot_contact_id = (select l.hubspot_contact_id from painel.leads l where l.id = p_lead))
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
create or replace function painel._relancar_reuniao(p_meeting uuid)
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
  where cm.carousel_id = c.id and cm.active and cm.weight > 0 and s.active and exists (select 1 from painel.google_connections g where g.closer_id = cm.closer_id and g.status = 'conectada');
  if v_total > 0 then
    insert into painel.carousel_ledger (carousel_id, closer_id, kind, amount, meeting_id, period_key)
    select c.id, cm.closer_id, 'credit', cm.weight::numeric / v_total, p_meeting, v_period
    from painel.carousel_members cm join painel.sdrs s on s.id = cm.closer_id
    where cm.carousel_id = c.id and cm.active and cm.weight > 0 and s.active and exists (select 1 from painel.google_connections g where g.closer_id = cm.closer_id and g.status = 'conectada');
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
create or replace function painel.reagendar_reuniao(p_meeting uuid, p_starts timestamptz, p_ends timestamptz, p_livres uuid[])
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
      and exists (select 1 from painel.google_connections g where g.closer_id = e.closer_id and g.status = 'conectada')
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

-- Closers que podem receber reunião neste carrossel agora (para consultar o Google). Só o servidor.
create function painel.closers_elegiveis(p_carousel uuid)
returns table (closer_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select m.closer_id
  from painel.carousel_members m
  join painel.sdrs s on s.id = m.closer_id
  join painel.carousels c on c.id = m.carousel_id and c.active
  where m.carousel_id = p_carousel and m.active and m.weight > 0 and s.active
    and exists (select 1 from painel.google_connections g where g.closer_id = m.closer_id and g.status = 'conectada');
$$;
revoke execute on function painel.closers_elegiveis(uuid) from public, anon, authenticated;
grant execute on function painel.closers_elegiveis(uuid) to service_role;

-- Closer a que o lead está preso neste carrossel (mesma regra de reservar_reuniao), ou null. Só o servidor.
create function painel.closer_preso(p_carousel uuid, p_lead uuid, p_hubspot_contact_id text default null)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select pm.closer_id
  from painel.meetings pm
  join painel.carousels c on c.id = p_carousel
  where pm.source = 'painel' and c.sticky_days > 0
    and pm.created_at >= now() - make_interval(days => c.sticky_days)
    and (pm.lead_id = p_lead
         or pm.hubspot_contact_id = coalesce(p_hubspot_contact_id, (select l.hubspot_contact_id from painel.leads l where l.id = p_lead)))
    and pm.closer_id in (select e.closer_id from painel.closers_elegiveis(p_carousel) e)
  order by pm.created_at desc
  limit 1;
$$;
revoke execute on function painel.closer_preso(uuid, uuid, text) from public, anon, authenticated;
grant execute on function painel.closer_preso(uuid, uuid, text) to service_role;

-- Lead do painel para um contato do HubSpot: o mais recente com esse contato; se não existir (lead sem chat),
-- cria um sem contato da Poli. Só o servidor.
create function painel.lead_para_agendar(p_hubspot_contact_id text, p_name text, p_company text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  select l.id into v_id from painel.leads l
  where l.hubspot_contact_id = p_hubspot_contact_id
  order by (l.poli_contact_uuid is not null) desc, l.created_at desc
  limit 1;
  if v_id is null then
    insert into painel.leads (hubspot_contact_id, name, company) values (p_hubspot_contact_id, p_name, p_company)
    returning id into v_id;
  end if;
  return v_id;
end;
$$;
revoke execute on function painel.lead_para_agendar(text, text, text) from public, anon, authenticated;
grant execute on function painel.lead_para_agendar(text, text, text) to service_role;

-- Busca de lead para agendar: o SDR só nos leads dele (chats dele); gestor e admin em todos.
create function painel.buscar_leads_para_agendar(p_q text)
returns table (lead_id uuid, name text, company text, phone_final text, hubspot_contact_id text, ultima_mensagem timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_scope uuid := painel.escopo_sdr();
  v_q text := trim(coalesce(p_q, ''));
  v_digits text := regexp_replace(coalesce(p_q, ''), '\D', '', 'g');
begin
  if length(v_q) < 2 then
    return;
  end if;
  return query
  select l.id, l.name, l.company, right(l.phone_e164, 4), l.hubspot_contact_id, max(c.last_message_at)
  from painel.leads l
  join painel.chats c on c.lead_id = l.id
  where (v_scope is null or c.sdr_id = v_scope)
    and (l.name ilike '%' || v_q || '%' or l.company ilike '%' || v_q || '%'
         or (length(v_digits) >= 4 and l.phone_e164 like '%' || v_digits || '%'))
  group by l.id
  order by max(c.last_message_at) desc nulls last
  limit 20;
end;
$$;
revoke execute on function painel.buscar_leads_para_agendar(text) from public, anon;
grant execute on function painel.buscar_leads_para_agendar(text) to authenticated, service_role;

-- Reuniões do painel já marcadas com este lead (pelo lead ou pelo contato do HubSpot). SDR, gestor e admin.
create function painel.reunioes_do_lead(p_lead uuid, p_hubspot_contact_id text)
returns table (id uuid, starts_at timestamptz, ends_at timestamptz, status text, carousel text, closer text, sdr text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform painel.escopo_sdr();  -- só SDR, gestor e admin ativos
  return query
  select m.id, m.starts_at, m.ends_at, m.status::text, ca.name, cl.name, sd.name
  from painel.meetings m
  left join painel.carousels ca on ca.id = m.carousel_id
  left join painel.sdrs cl on cl.id = m.closer_id
  left join painel.sdrs sd on sd.id = m.sdr_id
  where m.source = 'painel'
    and ((p_lead is not null and m.lead_id = p_lead)
         or (p_hubspot_contact_id is not null and m.hubspot_contact_id = p_hubspot_contact_id))
  order by m.starts_at desc
  limit 20;
end;
$$;
revoke execute on function painel.reunioes_do_lead(uuid, text) from public, anon;
grant execute on function painel.reunioes_do_lead(uuid, text) to authenticated, service_role;

-- Uma reunião do painel com a passagem de bastão. Só abrem: o closer dela, o SDR dela (ou quem agendou),
-- gestor e admin.
create function painel.reuniao_detalhe(p_id uuid)
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
  if v_role not in ('admin', 'gestor') and not exists (
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
revoke execute on function painel.reuniao_detalhe(uuid) from public, anon;
grant execute on function painel.reuniao_detalhe(uuid) to authenticated, service_role;

-- Carrosséis para agendar: agora com a faixa de usuários que sugere o carrossel. Sem nenhum dado de closer.
drop function painel.carrosseis_para_agendar();
create function painel.carrosseis_para_agendar()
returns table (id uuid, brand text, name text, description text, durations integer[],
               suggest_min_users integer, suggest_max_users integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform painel.escopo_sdr();   -- qualquer usuário ativo (SDR, gestor, admin); senão, acesso negado
  return query
  select c.id, c.brand::text, c.name, c.description, c.durations, c.suggest_min_users, c.suggest_max_users
  from painel.carousels c where c.active
  order by c.brand, c.sort, c.name;
end;
$$;
revoke execute on function painel.carrosseis_para_agendar() from public, anon;
grant execute on function painel.carrosseis_para_agendar() to authenticated, service_role;
