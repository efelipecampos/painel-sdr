-- Jornada · Acompanhamento, "Por template" (decisões do Felipe, 2026-10-16): o gestor escolhe um template e vê o
-- resultado dele no período, por quem enviou e por dia.
--   Receberam: leads distintos que receberam o template (pelo nome do template no Poli; inclui o template embutido).
--   Responderam de verdade: o lead mandou mensagem que não é resposta automática em até 24 h depois do envio.
--   Só resposta automática: nas 24 h, só o robô do lead respondeu.
--   Agendaram: reunião criada no painel ou entrada em Garantir Agendamento / Qualificado em até 24 h depois do envio.
--   Responderam fora das SDRs: responderam de verdade, mas num chat de gestor, closer ou sem dono (ninguém da equipe de
--   SDR vê a resposta).
-- Quem enviou: a pessoa da equipe que mandou o template, ou "Automação" (app token, sem autor).
-- Só gestor e admin.

create function painel.template_resultado(p_template text, p_from timestamptz, p_to timestamptz)
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
               where mt.lead_id = e.lead_id and mt.created_at > e.em and mt.created_at <= e.em + interval '24 hours')
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
revoke execute on function painel.template_resultado(text, timestamptz, timestamptz) from public, anon;
grant execute on function painel.template_resultado(text, timestamptz, timestamptz) to authenticated, service_role;

-- Quantas vezes cada template foi enviado desde uma data (para pôr os mais usados no topo da busca de template).
create function painel.templates_usados(p_desde timestamptz)
returns table (template_name text, envios integer)
language sql
stable
security definer
set search_path = ''
as $$
  select m.template_name, count(*)::integer
  from painel.chat_messages m
  where painel.is_manager() and m.sender = 'template' and m.template_name is not null and m.sent_at >= p_desde
  group by m.template_name;
$$;
revoke execute on function painel.templates_usados(timestamptz) from public, anon;
grant execute on function painel.templates_usados(timestamptz) to authenticated, service_role;
