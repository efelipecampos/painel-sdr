-- Excluir reunião (decisão do Felipe, 2026-10-28): só gestor/admin. Apaga o evento da agenda do closer (o HubSpot
-- apaga a Reunião junto), devolve a vez do closer no carrossel e a reunião fica registrada como excluída no painel.
-- Excluída não conta em nada: vira source = 'excluida', e tudo que conta reuniões do painel filtra source = 'painel'
-- (as duas funções que não filtravam, jornada_funil e template_resultado, passam a ignorar a excluída). Não impede
-- agendar de novo o mesmo lead. Continua na lista de Reuniões com o selo "Excluída".

alter table painel.meetings drop constraint meetings_source_check;
alter table painel.meetings add constraint meetings_source_check check (source in ('hubspot', 'manual', 'painel', 'excluida'));
alter table painel.meetings
  add column excluida_at timestamptz,
  add column excluida_por uuid references painel.profiles;

create or replace function painel.excluir_reuniao(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old painel.meeting_status;
  v_car uuid;
  v_clo uuid;
  v_period text;
begin
  if painel.permissao_reuniao(p_id) is distinct from 'gestor' then
    raise exception 'só gestor ou admin exclui reunião' using errcode = '42501';
  end if;
  select m.status into v_old from painel.meetings m where m.id = p_id for update;
  update painel.meetings
     set source = 'excluida', status = 'cancelada', status_changed_at = now(), status_changed_by = (select auth.uid()),
         excluida_at = now(), excluida_por = (select auth.uid()), hubspot_status_pendente = false, google_state = null
   where id = p_id;
  insert into painel.meeting_status_history (meeting_id, from_status, to_status, source, changed_by)
  values (p_id, v_old, 'cancelada', 'excluida', (select auth.uid()));
  -- devolve a vez sempre (independe de refund_cancelada do carrossel), uma vez só
  select l.carousel_id, l.closer_id, l.period_key into v_car, v_clo, v_period
  from painel.carousel_ledger l
  where l.meeting_id = p_id and l.kind = 'debit' and l.amount > 0
  order by l.id desc limit 1;
  if v_period is not null and not exists (
    select 1 from painel.carousel_ledger l
    where l.meeting_id = p_id and l.kind = 'refund' and l.carousel_id = v_car and l.closer_id = v_clo and l.period_key = v_period
    group by l.meeting_id having sum(l.amount) > 0
  ) then
    insert into painel.carousel_ledger (carousel_id, closer_id, kind, amount, meeting_id, period_key)
    values (v_car, v_clo, 'refund', 1, p_id, v_period);
  end if;
end;
$$;
revoke execute on function painel.excluir_reuniao(uuid) from public, anon;
grant execute on function painel.excluir_reuniao(uuid) to authenticated, service_role;

-- Lista de Reuniões: mostra também as excluídas (com o selo)
drop function painel.reunioes_lista(timestamptz, timestamptz);
create or replace function painel.reunioes_lista(p_from timestamptz, p_to timestamptz)
returns table (id uuid, starts_at timestamptz, ends_at timestamptz, status text, title text, lead_name text, company text,
               carousel text, brand text, closer text, sdr text, fora_do_padrao boolean, google_state text, permissao text, excluida boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_sdr uuid;
  v_uid uuid := (select auth.uid());
begin
  select p.role::text, p.sdr_id into v_role, v_sdr from painel.profiles p where p.id = v_uid and p.active;
  if v_role is null then
    raise exception 'acesso negado' using errcode = '42501';
  end if;
  return query
  select m.id, m.starts_at, m.ends_at, m.status::text, m.title, m.lead_name, m.company, ca.name, ca.brand::text,
         cl.name, sd.name, m.fora_do_padrao, m.google_state,
         case when v_role in ('admin', 'gestor') then 'gestor' when v_role = 'closer' then 'closer' else 'sdr' end,
         m.source = 'excluida'
  from painel.meetings m
  left join painel.carousels ca on ca.id = m.carousel_id
  left join painel.sdrs cl on cl.id = m.closer_id
  left join painel.sdrs sd on sd.id = m.sdr_id
  where m.source in ('painel', 'excluida') and m.starts_at >= p_from and m.starts_at < p_to
    and (v_role in ('admin', 'gestor')
         or (v_role = 'closer' and m.closer_id = v_sdr)
         or (v_role = 'sdr' and v_sdr is not null))   -- SDR vê todas (decisão de 2026-10-08)
  order by m.starts_at;
end;
$$;
revoke execute on function painel.reunioes_lista(timestamptz, timestamptz) from public, anon;
grant execute on function painel.reunioes_lista(timestamptz, timestamptz) to authenticated, service_role;

-- Funil da jornada e resultado por template: reunião excluída não conta como agendou
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
    join painel.chat_messages m on m.lead_id = t.lead_id and m.sent_at > t.t_at
      and ((m.sender = 'lead' and not m.auto_reply) or m.sender = 'template')
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
      join painel.meetings mt on mt.lead_id = l.id and mt.created_at >= b.criado - interval '1 minute' and mt.source <> 'excluida'
    union
    select b.contato from base b
      join painel.meetings mt on mt.hubspot_contact_id = b.contato and mt.created_at >= b.criado - interval '1 minute' and mt.source <> 'excluida'
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

create or replace function painel.template_resultado(p_template text, p_from timestamptz, p_to timestamptz)
returns table (dia date, quem text, receberam integer, responderam integer, so_automatica integer, agendaram integer, fora_das_sdrs integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not painel.is_manager() then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  return query
  with env as (
    select (m.sent_at at time zone 'America/Sao_Paulo')::date as dia,
           coalesce(s.name, 'Automação') as quem,
           m.lead_id,
           min(m.sent_at) as em
    from painel.chat_messages m
    left join painel.sdrs s on s.poli_attendant_uuid = m.author_poli_uuid
    where m.sender = 'template' and m.template_name = p_template and m.sent_at >= p_from and m.sent_at < p_to
    group by 1, 2, 3
  ),
  r as (
    select e.dia, e.quem, e.lead_id,
      exists (select 1 from painel.chat_messages x
               where x.lead_id = e.lead_id and x.sender = 'lead' and not x.auto_reply
                 and x.sent_at > e.em and x.sent_at <= e.em + interval '24 hours') as real,
      exists (select 1 from painel.chat_messages x
               where x.lead_id = e.lead_id and x.sender = 'lead' and x.auto_reply
                 and x.sent_at > e.em and x.sent_at <= e.em + interval '24 hours') as auto,
      exists (select 1 from painel.chat_messages x
               left join painel.sdrs d on d.id = x.sdr_id
               where x.lead_id = e.lead_id and x.sender = 'lead' and not x.auto_reply
                 and x.sent_at > e.em and x.sent_at <= e.em + interval '24 hours'
                 and d.role is distinct from 'sdr') as fora,
      exists (select 1 from painel.meetings mt
               where mt.lead_id = e.lead_id and mt.source <> 'excluida' and mt.created_at > e.em and mt.created_at <= e.em + interval '24 hours')
      or exists (select 1 from painel.leads l
                  join painel.hubspot_leads h on h.hubspot_contact_id = l.hubspot_contact_id
                 where l.id = e.lead_id and h.entered_agendado_at > e.em and h.entered_agendado_at <= e.em + interval '24 hours') as agendou
    from env e
  )
  select r.dia, r.quem,
         count(*)::integer,
         count(*) filter (where r.real)::integer,
         count(*) filter (where r.auto and not r.real)::integer,
         count(*) filter (where r.agendou)::integer,
         count(*) filter (where r.fora)::integer
  from r
  group by r.dia, r.quem
  order by r.dia desc, count(*) desc;
end;
$$;
