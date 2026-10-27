-- Dia da resposta parado desde 27/10 ~10h: depois da mudança do funil, o HubSpot passou a mandar parte das datas de
-- entrada nas etapas (hs_v2_date_entered_*) em milissegundos ("1790628210379"), e o ::timestamptz falhava para todos.
-- Aceita os dois formatos e converte o que já foi gravado.
create or replace function painel.data_hubspot(p text)
returns timestamptz
language sql
immutable
set search_path = ''
as $$
  select case when p ~ '^\d+$' then to_timestamp(p::bigint / 1000.0) else p::timestamptz end;
$$;

update painel.hubspot_leads h
   set etapas_entrada = (select jsonb_object_agg(e.key, to_jsonb(painel.data_hubspot(e.value)))
                           from jsonb_each_text(h.etapas_entrada) e)
 where exists (select 1 from jsonb_each_text(h.etapas_entrada) e where e.value ~ '^\d+$');

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
    select p.hubspot_lead_id, p.created_at, p.etapas_entrada, min(m.sent_at) as em
    from pend p
    join msg m on m.hubspot_contact_id = p.hubspot_contact_id
              and m.sent_at >= p.created_at - interval '1 day'
              and m.sent_at > coalesce(p.anterior, '-infinity'::timestamptz)
    group by p.hubspot_lead_id, p.created_at, p.etapas_entrada
  )
  select r.hubspot_lead_id,
         case when u.etapa is not null then (select s.value ->> u.etapa from painel.settings s where s.key = 'hubspot_cadencia_etapas')
              when r.em >= r.created_at then 'Respondeu D1'   -- ainda em Entrada
         end as dia,
         r.em
  from resp r
  left join lateral (
    select e.key as etapa from jsonb_each_text(r.etapas_entrada) e
     where painel.data_hubspot(e.value) <= r.em
     order by painel.data_hubspot(e.value) desc limit 1
  ) u on true
  where r.em < now() - interval '30 minutes'
  order by r.em
  limit greatest(coalesce(p_limit, 100), 1);
$$;
revoke execute on function painel.leads_para_marcar_dia(integer) from public, anon, authenticated;
grant execute on function painel.leads_para_marcar_dia(integer) to service_role;
