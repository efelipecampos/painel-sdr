-- business_seconds: segundos de [p_from, p_to) que caem dentro do horário comercial.
-- Usa painel.business_hours (por dia da semana, no fuso de negócio), painel.holidays
-- (excluídos quando a configuração 'holidays_off' é true) e o fuso de 'timezone'.
-- Intervalo vazio ou invertido retorna 0.

create function painel.business_seconds(p_from timestamptz, p_to timestamptz)
returns integer
language sql
stable
set search_path = ''
as $$
  with cfg as (
    select
      coalesce((select s.value #>> '{}' from painel.settings s where s.key = 'timezone'),
               'America/Sao_Paulo') as tz,
      coalesce((select (s.value #>> '{}')::boolean from painel.settings s where s.key = 'holidays_off'),
               true) as holidays_off
  ),
  days as (
    -- Cada dia local tocado pelo intervalo.
    select d::date as day, cfg.tz, cfg.holidays_off
    from cfg,
         generate_series((p_from at time zone cfg.tz)::date,
                         (p_to at time zone cfg.tz)::date,
                         interval '1 day') as d
    where p_to > p_from
  ),
  windows as (
    -- Janela de expediente de cada dia, convertida de volta para timestamptz.
    select (days.day + bh.start_time) at time zone days.tz as w_start,
           (days.day + bh.end_time) at time zone days.tz as w_end
    from days
    join painel.business_hours bh
      on bh.weekday = extract(dow from days.day) and bh.enabled
    where not (days.holidays_off
               and exists (select 1 from painel.holidays h where h.day = days.day))
  )
  select coalesce(
    sum(greatest(0, extract(epoch from least(p_to, w_end) - greatest(p_from, w_start)))),
    0
  )::integer
  from windows;
$$;

revoke execute on function painel.business_seconds(timestamptz, timestamptz) from public, anon;
grant execute on function painel.business_seconds(timestamptz, timestamptz) to authenticated, service_role;

-- Valores iniciais (editáveis na tela de Configurações).
-- Horário: segunda a sexta 08:00–18:00; sábado e domingo desligados (protótipo aprovado).
insert into painel.business_hours (weekday, enabled, start_time, end_time) values
  (0, false, '08:00', '12:00'),
  (1, true,  '08:00', '18:00'),
  (2, true,  '08:00', '18:00'),
  (3, true,  '08:00', '18:00'),
  (4, true,  '08:00', '18:00'),
  (5, true,  '08:00', '18:00'),
  (6, false, '08:00', '12:00');

insert into painel.settings (key, value) values
  ('timezone', '"America/Sao_Paulo"'),
  ('stale_minutes', '30'),
  ('holidays_off', 'true');
