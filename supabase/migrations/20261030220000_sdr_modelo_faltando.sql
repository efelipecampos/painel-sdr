-- Fase 9b — SDR Modelo: "dias faltando" conta só os dias sem cálculo nenhum. O dia de ontem é refeito a cada
-- leitura até o fim de hoje (eventos atrasados), mas já tem número guardado: não deve deixar o aviso de
-- "ainda calculando" preso na tela.
create or replace function painel.sdr_modelo_preparar(p_de date, p_ate date, p_max integer default 10)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inicio date := '2026-10-01';
  v_ate date := least(p_ate, (now() at time zone 'America/Sao_Paulo')::date - 1);
  v_dia date;
  v_feitos integer := 0;
begin
  for v_dia in
    select d::date from generate_series(greatest(p_de, v_inicio), v_ate, interval '1 day') d
     where not exists (select 1 from painel.sdr_modelo_dias x where x.dia = d::date
                         and x.calculado_em >= ((d::date + 2)::timestamp at time zone 'America/Sao_Paulo'))
     order by d desc
  loop
    if v_feitos >= p_max then
      exit;
    end if;
    delete from painel.sdr_modelo_dias x where x.dia = v_dia;
    insert into painel.sdr_modelo_dias (dia) values (v_dia) on conflict do nothing;
    if found then
      insert into painel.sdr_modelo_dia_sdr (dia, sdr_id, abordados, responderam, descartados, pri, pri_biz, res, res_biz)
      select v_dia, c.* from painel.sdr_modelo_calcular_dia(v_dia) c;
    end if;
    v_feitos := v_feitos + 1;
  end loop;
  return (select count(*)::integer from generate_series(greatest(p_de, v_inicio), v_ate, interval '1 day') d
           where not exists (select 1 from painel.sdr_modelo_dias x where x.dia = d::date));
end;
$$;
