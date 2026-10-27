-- Reuniões: o HubSpot vira a fonte da reunião e do status (decisão do Felipe, 2026-10-27).
-- O painel cria só o evento no Google Calendar; a integração Calendar→HubSpot cria a Reunião no HubSpot (com o id
-- do evento em hs_unique_id). O worker acha essa Reunião, liga ao Lead e lê dela o status. O painel não cria mais
-- Reunião no HubSpot (era o que duplicava) e o status deixa de ser marcado no painel.

-- Reunião que a integração do Calendar criou no HubSpot (a "oficial").
alter table painel.meetings
  add column hubspot_agenda_meeting_id text,
  add column hubspot_agenda_visto_at timestamptz,
  add column hubspot_outcome text,
  -- cancelada no HubSpot: o evento fica na agenda do closer (movê-lo apaga a Reunião oficial no HubSpot), marcado
  -- como Disponível e cinza, para liberar o horário. true = já liberado no Google.
  add column google_liberada boolean not null default false;

-- O status vem do HubSpot nas reuniões a partir deste dia; as anteriores ficam como estão ("daqui para trás,
-- aceitar o retrabalho").
insert into painel.settings (key, value) values ('reunioes_status_hubspot_desde', to_jsonb('2026-10-28T03:00:00Z'::text))
on conflict (key) do nothing;

-- Status no painel fica travado: só o worker grava, a partir do HubSpot.
create or replace function painel.definir_status_reuniao(p_id uuid, p_status text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'a situação da reunião é definida no HubSpot' using errcode = '42501';
end;
$$;

-- Grava o status lido do HubSpot, com histórico (source = 'hubspot'). Só o worker (service_role) chama.
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
  update painel.meetings set hubspot_outcome = p_outcome where id = p_id;
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
revoke execute on function painel.aplicar_status_hubspot(uuid, text, text) from public, anon, authenticated;
grant execute on function painel.aplicar_status_hubspot(uuid, text, text) to service_role;

-- As já canceladas pelo painel foram para a agenda de arquivo: nada a liberar.
update painel.meetings set google_liberada = true where status = 'cancelada';
