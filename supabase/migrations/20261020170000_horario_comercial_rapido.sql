-- Painel lento de novo (2026-10-20): na tela do Time, o tempo de resposta do mês testa linha por linha se cada
-- mensagem caiu no expediente (painel.is_business_time). A versão antiga chamava business_seconds(p, p + 1 s),
-- que monta a série de dias e as janelas a cada chamada: 6.372 linhas no mês levavam 4,9 s e a tela ia a 5,5 s,
-- perto do limite de 8 s do banco.
-- Esta versão olha direto a janela do dia local, com a mesma regra: dentro do expediente quando o segundo que
-- começa em p_at encosta na janela [início, fim) de um dia ligado e que não é feriado (com holidays_off).
-- Conferida em produção contra a antiga em 71.110 horários (mensagens, respostas e uma grade de 7 min): 0 diferenças.
create or replace function painel.is_business_time(p_at timestamptz)
returns boolean
language sql
stable
set search_path = ''
as $$
  with cfg as (
    select coalesce((select s.value #>> '{}' from painel.settings s where s.key = 'timezone'),
                    'America/Sao_Paulo') as tz,
           coalesce((select (s.value #>> '{}')::boolean from painel.settings s where s.key = 'holidays_off'),
                    true) as holidays_off
  ),
  l as (
    select (p_at at time zone cfg.tz) as ts, cfg.holidays_off from cfg
  )
  select exists (
    select 1
    from l
    join painel.business_hours bh on bh.enabled and bh.weekday = extract(dow from l.ts)
    where (l.ts::date + bh.start_time) - interval '1 second' < l.ts
      and l.ts < (l.ts::date + bh.end_time)
      and not (l.holidays_off and exists (select 1 from painel.holidays h where h.day = l.ts::date))
  );
$$;
