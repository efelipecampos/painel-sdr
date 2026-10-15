-- Funil da Jornada mais rápido (2026-10-15): a primeira versão recalculava "clicou" e "agendou" uma vez por etapa e
-- buscava as reuniões contato a contato, e passava de 8 s para o mês. Mesmas definições de 20261015170000_jornada_funil.sql;
-- agora cada passo é calculado uma vez, em bloco.

create or replace function painel.jornada_funil(p_from timestamptz, p_to timestamptz)
returns table (etapa integer, nome text, expediente integer, fora integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_pipe text := (select s.value #>> '{}' from painel.settings s where s.key = 'hubspot_pipeline_sdr');
  v_dsq text := (select s.value #>> '{}' from painel.settings s where s.key = 'hubspot_stage_dsq');
begin
  if not painel.is_manager() then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  return query
  with base as materialized (
    select distinct on (h.hubspot_contact_id) h.hubspot_contact_id as contato, h.created_at as criado
    from painel.hubspot_leads h
    where h.pipeline_id = v_pipe and h.hubspot_contact_id is not null
      and h.created_at >= p_from and h.created_at < p_to
      and h.entered_dsq_at is null and h.stage_id is distinct from v_dsq
    order by h.hubspot_contact_id, h.created_at
  ),
  tpl as materialized (
    select distinct on (b.contato) b.contato, m.sent_at as t_at, m.raw_event_id, m.lead_id
    from base b
    join painel.leads l on l.hubspot_contact_id = b.contato
    join painel.chat_messages m on m.lead_id = l.id and m.sender = 'template' and m.sent_at >= b.criado - interval '1 minute'
    order by b.contato, m.sent_at
  ),
  resposta as materialized (
    select distinct on (t.contato) t.contato, m.sender, m.body, t.raw_event_id
    from tpl t
    join painel.chat_messages m on m.lead_id = t.lead_id and m.sent_at > t.t_at and m.sender in ('lead', 'template')
    order by t.contato, m.sent_at
  ),
  clicou as materialized (
    select distinct r.contato
    from resposta r
    join public.raw_events e on e.id = r.raw_event_id
    cross join lateral jsonb_array_elements(coalesce(e.payload -> 'value' -> 'template' -> 'message' -> 'buttons', '[]'::jsonb)) bt
    where r.sender = 'lead' and bt ->> 'type' = 'reply'
      and lower(btrim(regexp_replace(r.body, '\s+', ' ', 'g'))) = lower(btrim(regexp_replace(bt ->> 'text', '\s+', ' ', 'g')))
  ),
  agendou as materialized (
    select b.contato from base b
      join painel.leads l on l.hubspot_contact_id = b.contato
      join painel.meetings mt on mt.lead_id = l.id and mt.created_at >= b.criado - interval '1 minute'
    union
    select b.contato from base b
      join painel.meetings mt on mt.hubspot_contact_id = b.contato and mt.created_at >= b.criado - interval '1 minute'
    union
    select b.contato from base b
      join painel.hubspot_leads h on h.hubspot_contact_id = b.contato and h.pipeline_id = v_pipe
        and h.created_at >= b.criado and h.entered_agendado_at is not null
  ),
  c as materialized (
    select b.contato, painel.is_business_time(b.criado) as exp,
      t.contato is not null as enviou, k.contato is not null as clicou, a.contato is not null as agendou
    from base b
    left join tpl t on t.contato = b.contato
    left join clicou k on k.contato = b.contato
    left join (select distinct contato from agendou) a on a.contato = b.contato
  )
  select x.etapa, x.nome,
    count(*) filter (where c.exp and x.ok)::integer,
    count(*) filter (where not c.exp and x.ok)::integer
  from c
  cross join lateral (values
    (1, 'Lead criado', true),
    (2, 'Template 1 enviado', c.enviou),
    (3, 'Clicou em um dos botões', c.clicou),
    (4, 'Agendamento', c.agendou)
  ) as x(etapa, nome, ok)
  group by x.etapa, x.nome
  order by x.etapa;
end;
$$;
