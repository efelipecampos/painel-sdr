-- "Respondeu algum dia de prospecção?" no Lead do HubSpot (decisão do Felipe, 2026-10-26).
-- O dia é a etapa em que o Lead estava quando o lead respondeu pela primeira vez (resposta de pessoa ou clique; resposta
-- automática não conta): Dia 1 / D1 Realizado = "Respondeu D1", ... Dia 4 = "Respondeu D4", Finalizar Cadência =
-- "Respondeu Término de Carteiro" (valor interno da opção no HubSpot). Grava uma vez, com o primeiro dia, e não muda.
-- Resposta em etapa fora da cadência (Entrada, Garantir Agendamento, Qualificado, Descartado, DSQ) não marca nada.

-- Datas de entrada nas etapas da cadência e nas de saída dela (id da etapa → data), vindas de hs_v2_date_entered_*.
alter table painel.hubspot_leads
  add column etapas_entrada jsonb,
  add column respondeu_dia text,
  add column respondeu_dia_marcado_at timestamptz;

-- Etapa da cadência (pipeline "[New] Pipeline SDR") → valor da opção no HubSpot.
insert into painel.settings (key, value) values ('hubspot_cadencia_etapas', '{
  "1250885428": "Respondeu D1", "1250885429": "Respondeu D1",
  "1250901135": "Respondeu D2", "1250885430": "Respondeu D2",
  "1250901136": "Respondeu D3", "1250901150": "Respondeu D3",
  "1250901137": "Respondeu D4",
  "1250901138": "Respondeu Término de Carteiro"
}'::jsonb)
on conflict (key) do update set value = excluded.value, updated_at = now();

-- Leads com primeira resposta ainda sem dia marcado. dia nulo = respondeu fora da cadência (o worker só registra).
-- Espera 30 min depois da resposta para o sync dos Leads (a cada 15 min) trazer a etapa daquele momento.
-- Só Leads criados nos últimos 45 dias (cadência + término cabem com folga).
create or replace function painel.leads_para_marcar_dia(p_limit integer default 100)
returns table (hubspot_lead_id text, dia text, respondeu_em timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  with pend as materialized (
    select h.hubspot_lead_id, h.hubspot_contact_id, h.created_at, h.etapas_entrada,
           (select max(h2.created_at) from painel.hubspot_leads h2
             where h2.hubspot_contact_id = h.hubspot_contact_id and h2.created_at < h.created_at) as anterior
    from painel.hubspot_leads h
    where h.hubspot_contact_id is not null
      and h.created_at >= now() - interval '45 days'
      and h.respondeu_dia_marcado_at is null
      and h.etapas_entrada is not null
  ),
  msg as materialized (
    select l.hubspot_contact_id, m.sent_at
    from painel.chat_messages m
    join painel.leads l on l.id = m.lead_id
    where m.sender = 'lead' and not m.auto_reply
      and l.hubspot_contact_id in (select pend.hubspot_contact_id from pend)
  ),
  resp as (
    select p.hubspot_lead_id, p.etapas_entrada, min(m.sent_at) as em
    from pend p
    join msg m on m.hubspot_contact_id = p.hubspot_contact_id
              and m.sent_at >= p.created_at - interval '1 day'
              and m.sent_at > coalesce(p.anterior, '-infinity'::timestamptz)
    group by p.hubspot_lead_id, p.etapas_entrada
  )
  select r.hubspot_lead_id,
         (select s.value ->> e.key
            from jsonb_each_text(r.etapas_entrada) e, painel.settings s
           where s.key = 'hubspot_cadencia_etapas' and e.value::timestamptz <= r.em
           order by e.value::timestamptz desc limit 1) as dia,
         r.em
  from resp r
  where r.em < now() - interval '30 minutes'
  order by r.em
  limit greatest(coalesce(p_limit, 100), 1);
$$;
revoke execute on function painel.leads_para_marcar_dia(integer) from public, anon, authenticated;
grant execute on function painel.leads_para_marcar_dia(integer) to service_role;
