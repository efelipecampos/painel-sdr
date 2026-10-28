-- Reunião flash (decisão do Felipe, 2026-10-28): o SDR está com o cliente na linha e passa na hora para um closer
-- que ele mesmo escolheu (viu a mesa livre). Começa em 5, 10 ou 15 min, dura 60 min, qualquer closer ativo com
-- agenda conectada (ocupado só avisa). Conta no equilíbrio do carrossel como as outras: crédito para os elegíveis e
-- débito para o closer escolhido, se ele for do carrossel (se não for, a reunião fica fora do equilíbrio, porque o
-- carrossel só reparte entre os membros). Ignora o "lead preso ao closer". assigned_by = 'flash' (selo no painel);
-- a descrição do evento leva a palavra "flash", que a integração do Calendar leva para o HubSpot.

alter table painel.meetings drop constraint meetings_assigned_by_check;
alter table painel.meetings add constraint meetings_assigned_by_check check (assigned_by in ('carrossel', 'manual', 'flash'));

create or replace function painel.reservar_reuniao_flash(
  p_carousel uuid,
  p_lead uuid,
  p_closer uuid,
  p_starts timestamptz,
  p_ends timestamptz,
  p_sdr uuid default null,
  p_created_by uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  c painel.carousels;
  v_period text;
  v_meeting uuid;
  v_total numeric;
begin
  perform pg_advisory_xact_lock(hashtext('painel.agendamento'));
  select * into c from painel.carousels where id = p_carousel and active;
  if c.id is null then
    raise exception 'carrossel inexistente ou arquivado' using errcode = 'P0002';
  end if;
  if p_lead is null or p_ends <= p_starts then
    raise exception 'lead e horário são obrigatórios' using errcode = '22023';
  end if;
  if not exists (select 1 from painel.sdrs s join painel.google_connections g on g.closer_id = s.id
                 where s.id = p_closer and s.active and g.status = 'conectada') then
    raise exception 'closer inativo ou sem agenda conectada' using errcode = 'P0001', hint = 'closer_sem_agenda';
  end if;
  v_period := painel.period_key(now(), c.balance_period);

  insert into painel.meetings (lead_id, sdr_id, status, source, carousel_id, closer_id, starts_at, ends_at,
                               assigned_by, created_by, status_changed_at)
  values (p_lead, p_sdr, 'agendada', 'painel', p_carousel, p_closer, p_starts, p_ends,
          'flash', p_created_by, now())
  returning id into v_meeting;

  -- mesmo lançamento do carrossel, só quando o closer escolhido é elegível nele
  create temp table if not exists _eleg_flash (closer_id uuid, weight integer) on commit drop;
  truncate _eleg_flash;
  insert into _eleg_flash
  select m.closer_id, m.weight
  from painel.carousel_members m join painel.sdrs s on s.id = m.closer_id
  where m.carousel_id = p_carousel and m.active and m.weight > 0 and s.active
    and exists (select 1 from painel.google_connections g where g.closer_id = m.closer_id and g.status = 'conectada');
  if exists (select 1 from _eleg_flash e where e.closer_id = p_closer) then
    select sum(weight) into v_total from _eleg_flash;
    insert into painel.carousel_ledger (carousel_id, closer_id, kind, amount, meeting_id, period_key)
    select p_carousel, e.closer_id, 'credit', e.weight::numeric / v_total, v_meeting, v_period from _eleg_flash e;
    insert into painel.carousel_ledger (carousel_id, closer_id, kind, amount, meeting_id, period_key)
    values (p_carousel, p_closer, 'debit', 1, v_meeting, v_period);
  end if;
  return v_meeting;
end;
$$;
revoke execute on function painel.reservar_reuniao_flash(uuid, uuid, uuid, timestamptz, timestamptz, uuid, uuid) from public, anon, authenticated;
grant execute on function painel.reservar_reuniao_flash(uuid, uuid, uuid, timestamptz, timestamptz, uuid, uuid) to service_role;
