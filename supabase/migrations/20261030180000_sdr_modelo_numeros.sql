-- Fase 9a — SDR Modelo: os números de cada SDR, o SDR Ideal (versões) e a aderência (docs/sdr-modelo.md).
-- Decisões do Felipe (2026-10-30):
--   - Descartes = descartados ÷ leads abordados (descartados ÷ responderam passava de 100%: a maioria nunca respondeu).
--   - Confirmação de reunião = alguém da equipe (qualquer pessoa, não só o SDR) escreveu ao lead nos 60 min antes
--     do início. Reunião marcada menos de 60 min antes (ex.: flash) fica fora da conta.
-- Os comportamentos de conversa (IA) entram na 9c; aqui só os números.

-- 1) SDR Ideal: cada versão guarda a lista inteira de comportamentos (faixa, lado melhor, peso, ativo).
--    Nunca se edita uma versão: salvar cria outra. A aderência de um período usa a versão em uso no fim dele.
create table painel.sdr_ideal_versoes (
  versao integer primary key,
  created_at timestamptz not null default now(),
  created_by uuid,                                    -- null = criada pelo sistema
  origem text not null check (origem in ('inicial', 'edicao', 'sugestao')),
  mudancas text[] not null default '{}',              -- o que mudou, em português, para o histórico
  comportamentos jsonb not null check (jsonb_typeof(comportamentos) = 'array')
  -- cada item: {id, grupo ('num'|'ia'), nome, medida, unidade, lo, hi, melhor (1|-1|0), peso, ativo, descricao?}
  -- unidades: 'leads/dia', 's' (segundos), '%' (0 a 100), 'nota' (0 a 10)
);

alter table painel.sdr_ideal_versoes enable row level security;
grant all on painel.sdr_ideal_versoes to service_role;
grant select on painel.sdr_ideal_versoes to authenticated;
-- todo usuário ativo lê (o SDR vê a faixa na própria aderência); gravar só pelas funções (9b)
create policy sdr_ideal_versoes_ler on painel.sdr_ideal_versoes for select to authenticated
  using ((select painel.is_active_user()));


-- 2) Dias úteis entre [de, até), no fuso de negócio, com o expediente e os feriados das Configurações.
--    O dia de hoje conta inteiro; o período não passa de agora.
create or replace function painel.dias_uteis(p_from timestamptz, p_to timestamptz)
returns integer
language sql
stable
set search_path = ''
as $$
  select count(*)::integer
    from generate_series((p_from at time zone 'America/Sao_Paulo')::date,
                         ((least(p_to, now()) - interval '1 microsecond') at time zone 'America/Sao_Paulo')::date,
                         interval '1 day') d
    join painel.business_hours b on b.weekday = extract(dow from d)::int and b.enabled
   where not (coalesce((select (s.value #>> '{}')::boolean from painel.settings s where s.key = 'holidays_off'), true)
              and exists (select 1 from painel.holidays h where h.day = d::date));
$$;


-- 3) Os 7 números de cada SDR no período. Reaproveita sdr_metrics (mesmas definições do painel).
--    Reuniões pela data de início, sem as excluídas. O SDR só recebe a própria linha.
create or replace function painel.sdr_modelo_numeros(p_from timestamptz, p_to timestamptz)
returns table (
  sdr_id uuid, name text, dias_uteis integer,
  leads_abordados integer, leads_responderam integer, descartados integer,
  primeira_resposta_s integer, leads_primeira_resposta integer, resposta_s integer, leads_resposta integer,
  reunioes integer, validadas integer, reunioes_confirmacao integer, confirmadas integer,
  volume numeric, taxa_resposta numeric, taxa_descarte numeric, taxa_validadas numeric, taxa_confirmacao numeric
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_scope uuid := painel.escopo_sdr();   -- só checa o acesso (SDR vê tudo no painel)
  v_own uuid;
  v_dias integer := painel.dias_uteis(p_from, p_to);
begin
  -- SDR Modelo: o SDR vê só a dele (docs/sdr-modelo.md §1)
  select p.sdr_id into v_own from painel.profiles p where p.id = (select auth.uid()) and p.role = 'sdr';

  return query
  with sm as (
    select * from painel.sdr_metrics(p_from, p_to)
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
  )
  select sm.sdr_id, sm.name, v_dias,
         sm.leads_abordados, sm.leads_responderam, sm.descartados,
         sm.primeira_resposta_s, sm.leads_primeira_resposta, sm.resposta_s, sm.leads_resposta,
         coalesce(mg.reunioes, 0), coalesce(mg.validadas, 0), coalesce(mg.base_conf, 0), coalesce(mg.confirmadas, 0),
         case when v_dias > 0 then round(sm.leads_abordados::numeric / v_dias, 1) end,
         case when sm.leads_abordados > 0 then round(100.0 * sm.leads_responderam / sm.leads_abordados, 1) end,
         case when sm.leads_abordados > 0 then round(100.0 * sm.descartados / sm.leads_abordados, 1) end,
         case when sm.leads_responderam > 0 then round(100.0 * coalesce(mg.validadas, 0) / sm.leads_responderam, 1) end,
         case when coalesce(mg.base_conf, 0) > 0 then round(100.0 * mg.confirmadas / mg.base_conf, 1) end
    from sm
    left join mg on mg.sdr_id = sm.sdr_id
   where v_own is null or sm.sdr_id = v_own
   order by sm.name;
end;
$$;


-- 4) Versão do SDR Ideal em uso no fim do período (a primeira, se o período é anterior a todas).
create or replace function painel.sdr_ideal_em_uso(p_at timestamptz)
returns painel.sdr_ideal_versoes
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select v from painel.sdr_ideal_versoes v where v.created_at <= p_at order by v.versao desc limit 1),
    (select v from painel.sdr_ideal_versoes v order by v.versao limit 1));
$$;


-- 5) Aderência: uma linha por SDR e comportamento numérico ativo da versão em uso.
--    situacao: 'dentro' | 'melhor' (fora da faixa, do lado melhor: conta como dentro) | 'acima' | 'abaixo'
--              | 'amostra_pequena' (fora da nota) | 'sem_dado' (sem valor ou sem faixa; fora da nota).
--    Amostra pequena: menos de 3 reuniões (validadas e confirmação) ou menos de 10 respostas na mediana.
--    aderencia = pesos dentro ou melhor ÷ pesos avaliados, de 0 a 100 (repetida em cada linha do SDR).
create or replace function painel.sdr_modelo_aderencia(p_from timestamptz, p_to timestamptz)
returns table (
  sdr_id uuid, name text, versao integer, comportamento text, valor numeric, base integer,
  lo numeric, hi numeric, melhor integer, peso numeric, situacao text, aderencia integer
)
language plpgsql
stable
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
    select n.sdr_id, n.name, c.id, c.lo, c.hi, c.melhor, c.peso,
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
                / nullif(sum(s.peso) filter (where s.situacao in ('dentro', 'melhor', 'acima', 'abaixo')) over w, 0)))::integer
    from s
  window w as (partition by s.sdr_id)
   order by s.name, s.id;
end;
$$;


-- 6) Faixas da 1ª versão (docs/sdr-modelo.md §3): os 3 SDRs com maior taxa de reuniões validadas no período,
--    entre os que têm amostra (3 reuniões ou mais); a faixa vai do pior ao melhor valor entre eles.
--    Devolve a lista de comportamentos pronta para gravar. Sem 3 SDRs com amostra, as faixas ficam vazias.
create or replace function painel.sdr_ideal_faixas_dos_melhores(p_from timestamptz, p_to timestamptz)
returns jsonb
language sql
stable
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


revoke execute on function painel.dias_uteis(timestamptz, timestamptz) from public, anon;
revoke execute on function painel.sdr_modelo_numeros(timestamptz, timestamptz) from public, anon;
revoke execute on function painel.sdr_ideal_em_uso(timestamptz) from public, anon;
revoke execute on function painel.sdr_modelo_aderencia(timestamptz, timestamptz) from public, anon;
revoke execute on function painel.sdr_ideal_faixas_dos_melhores(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function painel.dias_uteis(timestamptz, timestamptz) to authenticated, service_role;
grant execute on function painel.sdr_modelo_numeros(timestamptz, timestamptz) to authenticated, service_role;
grant execute on function painel.sdr_ideal_em_uso(timestamptz) to authenticated, service_role;
grant execute on function painel.sdr_modelo_aderencia(timestamptz, timestamptz) to authenticated, service_role;
grant execute on function painel.sdr_ideal_faixas_dos_melhores(timestamptz, timestamptz) to service_role;


-- 7) Versão 1: faixas dos 3 melhores dos últimos 30 dias, calculadas na hora em que a migration roda.
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into painel.sdr_ideal_versoes (versao, origem, mudancas, comportamentos)
select 1, 'inicial',
       array['Primeira versão: faixas dos 3 SDRs com maior taxa de reuniões validadas nos últimos 30 dias'],
       painel.sdr_ideal_faixas_dos_melhores(now() - interval '30 days', now());
