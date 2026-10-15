-- Jornada · Acompanhamento (Fase 11, decisão do Felipe em 2026-10-15): funil simples de 4 etapas, separado entre
-- expediente e fora do expediente pela hora em que o Lead foi criado.
--   1. Lead criado: Lead do pipeline do SDR criado no período, sem DSQ (um por contato, o primeiro do período).
--   2. Template 1 enviado: o contato recebeu um template depois de o Lead ser criado (1 min de folga).
--   3. Clicou em um dos botões: a primeira mensagem do lead depois desse template é o texto de um botão dele.
--   4. Agendamento: o contato tem reunião no painel criada depois do Lead, ou o Lead passou por Garantir
--      Agendamento ou Qualificado (entered_agendado_at).
-- Só gestor e admin (e o servidor).

create function painel.jornada_funil(p_from timestamptz, p_to timestamptz)
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
  with base as (
    select distinct on (h.hubspot_contact_id) h.hubspot_contact_id as contato, h.created_at as criado
    from painel.hubspot_leads h
    where h.pipeline_id = v_pipe and h.hubspot_contact_id is not null
      and h.created_at >= p_from and h.created_at < p_to
      and h.entered_dsq_at is null and h.stage_id is distinct from v_dsq
    order by h.hubspot_contact_id, h.created_at
  ),
  tpl as (
    select b.contato, b.criado, painel.is_business_time(b.criado) as exp, t.sent_at as t_at, t.raw_event_id, t.lead_id
    from base b
    left join lateral (
      select m.sent_at, m.raw_event_id, m.lead_id
      from painel.leads l join painel.chat_messages m on m.lead_id = l.id
      where l.hubspot_contact_id = b.contato and m.sender = 'template' and m.sent_at >= b.criado - interval '1 minute'
      order by m.sent_at limit 1
    ) t on true
  ),
  clk as (
    select t.*,
      t.t_at is not null and exists (
        select 1
        from lateral (
          select m.body from painel.chat_messages m
          where m.lead_id = t.lead_id and m.sent_at > t.t_at and m.sender in ('lead', 'template')
          order by m.sent_at limit 1
        ) r
        join public.raw_events e on e.id = t.raw_event_id
        cross join lateral jsonb_array_elements(coalesce(e.payload -> 'value' -> 'template' -> 'message' -> 'buttons', '[]'::jsonb)) bt
        where bt ->> 'type' = 'reply'
          and lower(btrim(regexp_replace(r.body, '\s+', ' ', 'g'))) = lower(btrim(regexp_replace(bt ->> 'text', '\s+', ' ', 'g')))
      ) as clicou,
      exists (
        select 1 from painel.meetings mt
        where (mt.hubspot_contact_id = t.contato or mt.lead_id in (select l.id from painel.leads l where l.hubspot_contact_id = t.contato))
          and mt.created_at >= t.criado - interval '1 minute'
      ) or exists (
        select 1 from painel.hubspot_leads h
        where h.hubspot_contact_id = t.contato and h.pipeline_id = v_pipe and h.created_at >= t.criado and h.entered_agendado_at is not null
      ) as agendou
    from tpl t
  )
  select x.etapa, x.nome,
    count(*) filter (where c.exp and x.ok)::integer,
    count(*) filter (where not c.exp and x.ok)::integer
  from clk c
  cross join lateral (values
    (1, 'Lead criado', true),
    (2, 'Template 1 enviado', c.t_at is not null),
    (3, 'Clicou em um dos botões', c.clicou),
    (4, 'Agendamento', c.agendou)
  ) as x(etapa, nome, ok)
  group by x.etapa, x.nome
  order by x.etapa;
end;
$$;
revoke execute on function painel.jornada_funil(timestamptz, timestamptz) from public, anon;
grant execute on function painel.jornada_funil(timestamptz, timestamptz) to authenticated, service_role;
