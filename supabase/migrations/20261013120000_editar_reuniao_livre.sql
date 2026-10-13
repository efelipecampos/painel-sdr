-- Edição livre de reunião por gestor e admin (decisão do Felipe, 2026-10-13): qualquer data e hora (inclusive no
-- passado, fim de semana ou fora de 07:00–21:00), qualquer duração e o closer que o gestor escolher, mesmo ocupado
-- (pode ficar sobreposto). O painel só avisa; nada bloqueia. O closer precisa ser do carrossel e ter a agenda
-- conectada, porque o evento vai para a agenda dele. Só o servidor chama, depois de conferir que quem pede é
-- gestor ou admin (permissao_reuniao = 'gestor').
create function painel.editar_reuniao_livre(p_meeting uuid, p_starts timestamptz, p_ends timestamptz, p_closer uuid, p_motivo text)
returns boolean  -- o closer mudou
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
  if p_starts is null or p_ends is null or p_ends <= p_starts then
    raise exception 'horário inválido' using errcode = '22023';
  end if;
  if p_closer is distinct from m.closer_id and not exists (
    select 1
    from painel.carousel_members e
    join painel.sdrs sd on sd.id = e.closer_id
    where e.carousel_id = m.carousel_id and e.closer_id = p_closer and sd.active
      and exists (select 1 from painel.google_connections g where g.closer_id = e.closer_id and g.status = 'conectada')
  ) then
    raise exception 'esse closer não é do carrossel desta reunião ou não tem a agenda conectada' using errcode = 'P0001';
  end if;

  update painel.meetings
     set starts_at = p_starts, ends_at = p_ends, closer_id = p_closer,
         assigned_by = case when p_closer = m.closer_id then m.assigned_by else 'manual' end,
         override_reason = case when p_closer = m.closer_id then m.override_reason else nullif(trim(p_motivo), '') end,
         status = case when m.status = 'cancelada' then 'agendada' else m.status end,
         status_changed_at = case when m.status = 'cancelada' then now() else m.status_changed_at end
   where id = p_meeting;
  if p_closer <> m.closer_id then
    perform painel._relancar_reuniao(p_meeting);
  end if;
  return p_closer <> m.closer_id;
end;
$$;
revoke execute on function painel.editar_reuniao_livre(uuid, timestamptz, timestamptz, uuid, text) from public, anon, authenticated;
grant execute on function painel.editar_reuniao_livre(uuid, timestamptz, timestamptz, uuid, text) to service_role;
