-- Status da reunião marcado no painel volta a valer e vai para a Reunião do HubSpot (decisão do Felipe, 2026-10-28).
-- O SDR trabalha as reuniões no painel; marcar de novo no HubSpot seria retrabalho. SDR, closer e gestor marcam
-- qualquer situação; o worker grava em hs_meeting_outcome da Reunião oficial (a do Calendar; sem ela, a antiga do
-- painel). Mudou nos dois lugares: vale a última mudança (o worker compara com a data da mudança no HubSpot).

-- true = o status mudou no painel e ainda não foi gravado no HubSpot.
alter table painel.meetings add column hubspot_status_pendente boolean not null default false;

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
         google_state = case when p_status = 'cancelada' then null else google_state end,
         hubspot_status_pendente = true
   where id = p_id;
  insert into painel.meeting_status_history (meeting_id, from_status, to_status, source, changed_by)
  values (p_id, v_old, p_status::painel.meeting_status, 'painel', (select auth.uid()));
  return v_old::text;
end;
$$;

-- Status vindo do HubSpot também resolve um pendente (o HubSpot mudou depois do painel).
create or replace function painel.aplicar_status_hubspot(p_id uuid, p_status text, p_outcome text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old painel.meeting_status;
begin
  select m.status into v_old from painel.meetings m where m.id = p_id for update;
  update painel.meetings set hubspot_outcome = p_outcome, hubspot_status_pendente = false where id = p_id;
  if v_old is null or v_old::text = p_status then
    return false;
  end if;
  update painel.meetings
     set status = p_status::painel.meeting_status, status_changed_at = now(), status_changed_by = null,
         google_state = case when p_status = 'cancelada' then null else google_state end
   where id = p_id;
  insert into painel.meeting_status_history (meeting_id, from_status, to_status, source, changed_by)
  values (p_id, v_old, p_status::painel.meeting_status, 'hubspot', null);
  return true;
end;
$$;
