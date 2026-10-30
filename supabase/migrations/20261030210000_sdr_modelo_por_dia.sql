-- SDR Modelo rápido: números guardados por dia e por SDR (30/10/2026).
-- sdr_modelo_numeros chamava painel.sdr_metrics, que leva ~12 s para 30 dias (o painel usa hoje e 7 dias). As telas do
-- SDR Modelo estouravam o limite de 8 s e seguravam o banco, e o painel principal deu timeout junto.
-- Agora cada dia fechado é calculado uma vez (~0,2 s) e guardado com os conjuntos de leads e os tempos de resposta, para
-- as contagens distintas e as medianas de qualquer período continuarem exatas. Hoje é calculado na hora.
-- Mesmas definições de sdr_metrics (spec.md §2). Única diferença: a amostra das medianas conta respostas, não leads.

create table painel.sdr_modelo_dias (
  dia date primary key,
  calculado_em timestamptz not null default now()
);

create table painel.sdr_modelo_dia_sdr (
  dia date not null references painel.sdr_modelo_dias (dia) on delete cascade,
  sdr_id uuid not null,
  abordados uuid[] not null default '{}',
  responderam uuid[] not null default '{}',
  descartados text[] not null default '{}',
  pri integer[] not null default '{}',       -- segundos da 1ª resposta, todos os blocos
  pri_biz integer[] not null default '{}',   -- só blocos que começaram no horário comercial
  res integer[] not null default '{}',
  res_biz integer[] not null default '{}',
  primary key (dia, sdr_id)
);

alter table painel.sdr_modelo_dias enable row level security;
alter table painel.sdr_modelo_dia_sdr enable row level security;
grant all on painel.sdr_modelo_dias, painel.sdr_modelo_dia_sdr to service_role;
-- sem acesso direto do navegador: só pelas funções


-- Um dia local (America/Sao_Paulo), por SDR.
create or replace function painel.sdr_modelo_calcular_dia(p_dia date)
returns table (sdr_id uuid, abordados uuid[], responderam uuid[], descartados text[],
               pri integer[], pri_biz integer[], res integer[], res_biz integer[])
language sql
stable
security definer
set search_path = ''
as $$
  with p as (
    select (p_dia::timestamp at time zone 'America/Sao_Paulo') f,
           ((p_dia + 1)::timestamp at time zone 'America/Sao_Paulo') t,
           (select array_agg(s.id) from painel.sdrs s where s.role = 'sdr') ids
  ),
  msg as (
    select m.sdr_id,
           coalesce(array_agg(distinct m.lead_id) filter (where m.sender in ('sdr', 'template', 'bot')), '{}') ab,
           coalesce(array_agg(distinct m.lead_id) filter (where m.sender = 'lead' and not m.auto_reply), '{}') re
      from p, painel.chat_messages m
     where m.sdr_id = any (p.ids) and m.sent_at >= p.f and m.sent_at < p.t
     group by m.sdr_id
  ),
  resp as (
    select r.sdr_id,
           coalesce(array_agg(r.seconds_24h) filter (where r.is_first_response), '{}') pri,
           coalesce(array_agg(r.seconds_24h) filter (where r.is_first_response and r.biz), '{}') pri_biz,
           coalesce(array_agg(r.seconds_24h), '{}') res,
           coalesce(array_agg(r.seconds_24h) filter (where r.biz), '{}') res_biz
      from (select r.sdr_id, r.seconds_24h, r.is_first_response, painel.is_business_time(r.lead_block_started_at) biz
              from p, painel.response_events r
             where r.sdr_id = any (p.ids) and r.lead_block_started_at >= p.f and r.lead_block_started_at < p.t
               and r.seconds_24h is not null) r
     group by r.sdr_id
  ),
  disc as (
    select d.sdr_id, array_agg(distinct d.lead_key) ds
      from p, painel.descartes(p.f, p.t) d
     where d.sdr_id = any (p.ids)
     group by d.sdr_id
  ),
  ids as (
    select msg.sdr_id from msg union select resp.sdr_id from resp union select disc.sdr_id from disc
  )
  select ids.sdr_id, coalesce(msg.ab, '{}'), coalesce(msg.re, '{}'), coalesce(disc.ds, '{}'),
         coalesce(resp.pri, '{}'), coalesce(resp.pri_biz, '{}'), coalesce(resp.res, '{}'), coalesce(resp.res_biz, '{}')
    from ids
    left join msg on msg.sdr_id = ids.sdr_id
    left join resp on resp.sdr_id = ids.sdr_id
    left join disc on disc.sdr_id = ids.sdr_id;
$$;


-- Guarda até p_max dias fechados que faltam entre p_de e p_ate (do mais recente para o mais antigo).
-- Dia calculado antes do fim do dia seguinte é refeito (eventos que chegam atrasados ou reprocessados).
-- Antes do início dos dados (01/10/2026) não há o que guardar. Devolve quantos dias ainda faltam.
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
           where not exists (select 1 from painel.sdr_modelo_dias x where x.dia = d::date
                               and x.calculado_em >= ((d::date + 2)::timestamp at time zone 'America/Sao_Paulo')));
end;
$$;


-- Mesma assinatura de antes, mais dias_faltando (dias fechados ainda sem cálculo; a tela avisa).
drop function painel.sdr_modelo_aderencia(timestamptz, timestamptz);
drop function painel.sdr_ideal_faixas_dos_melhores(timestamptz, timestamptz);
drop function painel.sdr_modelo_numeros(timestamptz, timestamptz);

create function painel.sdr_modelo_numeros(p_from timestamptz, p_to timestamptz)
returns table (
  sdr_id uuid, name text, dias_uteis integer,
  leads_abordados integer, leads_responderam integer, descartados integer,
  primeira_resposta_s integer, leads_primeira_resposta integer, resposta_s integer, leads_resposta integer,
  reunioes integer, validadas integer, reunioes_confirmacao integer, confirmadas integer,
  volume numeric, taxa_resposta numeric, taxa_descarte numeric, taxa_validadas numeric, taxa_confirmacao numeric,
  dias_faltando integer
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_scope uuid := painel.escopo_sdr();   -- só checa o acesso
  v_own uuid;
  v_dias integer := painel.dias_uteis(p_from, p_to);
  v_biz boolean := coalesce((select (s.value #>> '{}')::boolean from painel.settings s where s.key = 'metrics_business_only'), true);
  v_de date := (p_from at time zone 'America/Sao_Paulo')::date;
  v_ate date := ((p_to - interval '1 microsecond') at time zone 'America/Sao_Paulo')::date;
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_falta integer;
begin
  select p.sdr_id into v_own from painel.profiles p where p.id = (select auth.uid()) and p.role = 'sdr';
  v_falta := painel.sdr_modelo_preparar(v_de, v_ate, 10);

  return query
  with d as (
    select x.sdr_id, x.abordados, x.responderam, x.descartados,
           case when v_biz then x.pri_biz else x.pri end pri, case when v_biz then x.res_biz else x.res end res
      from painel.sdr_modelo_dia_sdr x
     where x.dia between v_de and least(v_ate, v_hoje - 1)
    union all
    select h.sdr_id, h.abordados, h.responderam, h.descartados,
           case when v_biz then h.pri_biz else h.pri end, case when v_biz then h.res_biz else h.res end
      from painel.sdr_modelo_calcular_dia(v_hoje) h
     where v_ate >= v_hoje and v_de <= v_hoje
  ),
  n as (
    select d.sdr_id,
           (select count(distinct u)::integer from d d2, unnest(d2.abordados) u where d2.sdr_id = d.sdr_id) ab,
           (select count(distinct u)::integer from d d2, unnest(d2.responderam) u where d2.sdr_id = d.sdr_id) re,
           (select count(distinct u)::integer from d d2, unnest(d2.descartados) u where d2.sdr_id = d.sdr_id) ds,
           (select round(percentile_cont(0.5) within group (order by u))::integer from d d2, unnest(d2.pri) u where d2.sdr_id = d.sdr_id) p1,
           (select count(*)::integer from d d2, unnest(d2.pri) u where d2.sdr_id = d.sdr_id) n1,
           (select round(percentile_cont(0.5) within group (order by u))::integer from d d2, unnest(d2.res) u where d2.sdr_id = d.sdr_id) p2,
           (select count(*)::integer from d d2, unnest(d2.res) u where d2.sdr_id = d.sdr_id) n2
      from (select distinct d.sdr_id from d) d
  ),
  mg as (
    select m.sdr_id,
           count(*) filter (where m.status in ('validada', 'invalidada', 'noshow'))::integer as reunioes,
           count(*) filter (where m.status = 'validada')::integer as validadas,
           count(*) filter (where m.status in ('validada', 'invalidada', 'noshow')
                              and m.created_at < m.starts_at - interval '60 minutes')::integer as base_conf,
           count(*) filter (where m.status in ('validada', 'invalidada', 'noshow')
                              and m.created_at < m.starts_at - interval '60 minutes'
                              and exists (select 1 from painel.chat_messages x
                                           where x.lead_id = m.lead_id and x.by_human
                                             and x.sent_at >= m.starts_at - interval '60 minutes'
                                             and x.sent_at < m.starts_at))::integer as confirmadas
      from painel.meetings m
     where m.starts_at >= p_from and m.starts_at < p_to and m.excluida_at is null
     group by m.sdr_id
  ),
  team as (
    -- SDRs ativos, e os desativados com atividade no período (como sdr_metrics)
    select s.id, s.name from painel.sdrs s
     where s.role = 'sdr' and (s.active or exists (select 1 from n where n.sdr_id = s.id))
  )
  select team.id, team.name, v_dias,
         coalesce(n.ab, 0), coalesce(n.re, 0), coalesce(n.ds, 0),
         n.p1, coalesce(n.n1, 0), n.p2, coalesce(n.n2, 0),
         coalesce(mg.reunioes, 0), coalesce(mg.validadas, 0), coalesce(mg.base_conf, 0), coalesce(mg.confirmadas, 0),
         case when v_dias > 0 then round(coalesce(n.ab, 0)::numeric / v_dias, 1) end,
         case when n.ab > 0 then round(100.0 * coalesce(n.re, 0) / n.ab, 1) end,
         case when n.ab > 0 then round(100.0 * coalesce(n.ds, 0) / n.ab, 1) end,
         case when n.re > 0 then round(100.0 * coalesce(mg.validadas, 0) / n.re, 1) end,
         case when coalesce(mg.base_conf, 0) > 0 then round(100.0 * mg.confirmadas / mg.base_conf, 1) end,
         v_falta
    from team
    left join n on n.sdr_id = team.id
    left join mg on mg.sdr_id = team.id
   where v_own is null or team.id = v_own
   order by team.name;
end;
$$;


-- Aderência e faixas da 1ª versão: mesmas regras, agora sobre os números por dia (e com o resumo de cada SDR).
create function painel.sdr_modelo_aderencia(p_from timestamptz, p_to timestamptz)
returns table (
  sdr_id uuid, name text, versao integer, comportamento text, valor numeric, base integer,
  lo numeric, hi numeric, melhor integer, peso numeric, situacao text, aderencia integer,
  leads_abordados integer, leads_responderam integer, reunioes integer, dias_faltando integer
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v painel.sdr_ideal_versoes := painel.sdr_ideal_em_uso(p_to);
begin
  if v.versao is null then
    return;
  end if;

  return query
  with n as (
    select * from painel.sdr_modelo_numeros(p_from, p_to)
  ),
  c as (
    select x.id, (x.lo)::numeric lo, (x.hi)::numeric hi, coalesce(x.melhor, 0) melhor, coalesce(x.peso, 0) peso
      from jsonb_to_recordset(v.comportamentos) as x(id text, grupo text, lo numeric, hi numeric, melhor integer, peso numeric, ativo boolean)
     where x.grupo = 'num' and coalesce(x.ativo, true)
  ),
  val as (
    select n.sdr_id, n.name, c.id, c.lo, c.hi, c.melhor, c.peso, n.leads_abordados, n.leads_responderam, n.reunioes, n.dias_faltando,
           case c.id
             when 'vol'  then n.volume
             when 'pri'  then n.primeira_resposta_s::numeric
             when 'res'  then n.resposta_s::numeric
             when 'tax'  then n.taxa_resposta
             when 'des'  then n.taxa_descarte
             when 'val'  then n.taxa_validadas
             when 'conf' then n.taxa_confirmacao
           end as valor,
           case c.id
             when 'vol'  then n.leads_abordados
             when 'pri'  then n.leads_primeira_resposta
             when 'res'  then n.leads_resposta
             when 'tax'  then n.leads_abordados
             when 'des'  then n.leads_abordados
             when 'val'  then n.reunioes
             when 'conf' then n.reunioes_confirmacao
           end as base,
           case c.id
             when 'pri'  then n.leads_primeira_resposta < 10
             when 'res'  then n.leads_resposta < 10
             when 'val'  then n.reunioes < 3
             when 'conf' then n.reunioes_confirmacao < 3
             else false
           end as pequena
      from n cross join c
  ),
  s as (
    select val.*,
           case
             when val.valor is null or val.lo is null or val.hi is null then 'sem_dado'
             when val.pequena then 'amostra_pequena'
             when val.valor between val.lo and val.hi then 'dentro'
             when val.valor > val.hi and val.melhor = 1 then 'melhor'
             when val.valor < val.lo and val.melhor = -1 then 'melhor'
             when val.valor > val.hi then 'acima'
             else 'abaixo'
           end as situacao
      from val
  )
  select s.sdr_id, s.name, v.versao, s.id, s.valor, s.base, s.lo, s.hi, s.melhor, s.peso, s.situacao,
         (round(100.0 * sum(s.peso) filter (where s.situacao in ('dentro', 'melhor')) over w
                / nullif(sum(s.peso) filter (where s.situacao in ('dentro', 'melhor', 'acima', 'abaixo')) over w, 0)))::integer,
         s.leads_abordados, s.leads_responderam, s.reunioes, s.dias_faltando
    from s
  window w as (partition by s.sdr_id)
   order by s.name, s.id;
end;
$$;



create function painel.sdr_ideal_faixas_dos_melhores(p_from timestamptz, p_to timestamptz)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  with n as (
    select * from painel.sdr_modelo_numeros(p_from, p_to)
  ),
  top as (
    select t.* from (select n.* from n
                      where n.reunioes >= 3 and n.taxa_validadas is not null
                      order by n.taxa_validadas desc, n.name limit 3) t
     where (select count(*) from n where n.reunioes >= 3 and n.taxa_validadas is not null) >= 3
  ),
  -- pesos do desenho (design/SDRIdeal.dc.html); os de conversa entram desligados até a 9c
  c(ordem, id, nome, medida, unidade, melhor, peso) as (values
    (1, 'vol',  'Volume',                 'Leads abordados por dia útil',               'leads/dia', 1, 15),
    (2, 'pri',  '1ª resposta',            'Mediana do tempo de primeira resposta',      's',        -1, 15),
    (3, 'res',  'Tempo de resposta',      'Mediana do tempo de resposta',               's',        -1, 10),
    (4, 'tax',  'Taxa de resposta',       'Leads que responderam ÷ abordados',          '%',         1, 15),
    (5, 'des',  'Descartes',              'Descartados ÷ leads abordados',              '%',         0, 10),
    (6, 'val',  'Reuniões validadas',     'Validadas ÷ leads que responderam',          '%',         1, 15),
    (7, 'conf', 'Confirmação de reunião', 'Alguém da equipe escreveu até 60 min antes', '%',         1, 10)
  ),
  f as (
    select c.*, min(x.v) lo, max(x.v) hi
      from c
      left join lateral (
        select case c.id
                 when 'vol' then top.volume when 'pri' then top.primeira_resposta_s::numeric
                 when 'res' then top.resposta_s::numeric when 'tax' then top.taxa_resposta
                 when 'des' then top.taxa_descarte when 'val' then top.taxa_validadas
                 when 'conf' then top.taxa_confirmacao
               end as v
          from top) x on true
     group by c.ordem, c.id, c.nome, c.medida, c.unidade, c.melhor, c.peso
  )
  select (select jsonb_agg(jsonb_build_object('id', f.id, 'grupo', 'num', 'nome', f.nome, 'medida', f.medida,
                                              'unidade', f.unidade, 'lo', f.lo, 'hi', f.hi, 'melhor', f.melhor,
                                              'peso', f.peso, 'ativo', true) order by f.ordem) from f)
         || jsonb_build_array(
              jsonb_build_object('id', 'per', 'grupo', 'ia', 'nome', 'Perguntas', 'medida', 'Nota da IA, de 0 a 10',
                'unidade', 'nota', 'lo', 7, 'hi', 9, 'melhor', 1, 'peso', 5, 'ativo', false,
                'descricao', 'Qualidade das perguntas, objetividade, se as perguntas levam à qualificação (tamanho da equipe, canal atual, dor).'),
              jsonb_build_object('id', 'gat', 'grupo', 'ia', 'nome', 'Gatilhos mentais', 'medida', 'Nota da IA, de 0 a 10',
                'unidade', 'nota', 'lo', 6, 'hi', 9, 'melhor', 1, 'peso', 5, 'ativo', false,
                'descricao', 'Uso de urgência, escassez, prova social, autoridade e dor. Mostrar quais gatilhos aparecem.'));
$$;



revoke execute on function painel.sdr_modelo_calcular_dia(date) from public, anon, authenticated;
revoke execute on function painel.sdr_modelo_preparar(date, date, integer) from public, anon, authenticated;
revoke execute on function painel.sdr_modelo_numeros(timestamptz, timestamptz) from public, anon;
revoke execute on function painel.sdr_modelo_aderencia(timestamptz, timestamptz) from public, anon;
revoke execute on function painel.sdr_ideal_faixas_dos_melhores(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function painel.sdr_modelo_calcular_dia(date) to service_role;
grant execute on function painel.sdr_modelo_preparar(date, date, integer) to service_role;
grant execute on function painel.sdr_modelo_numeros(timestamptz, timestamptz) to authenticated, service_role;
grant execute on function painel.sdr_modelo_aderencia(timestamptz, timestamptz) to authenticated, service_role;
grant execute on function painel.sdr_ideal_faixas_dos_melhores(timestamptz, timestamptz) to service_role;
