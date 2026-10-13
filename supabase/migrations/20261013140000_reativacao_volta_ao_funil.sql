-- Reativação (decisão do Felipe, 2026-10-13): template enviado ao lead DEPOIS do descarte começa um ciclo novo.
-- O lead volta a contar em "Aguardando" e "Parados" até ser descartado de novo (etapa no HubSpot, nota ou
-- "Finalizar" no painel). Motivo: leads descartados reativados por template (ex.: campanha do app) respondiam e
-- ficavam escondidos como "Fora do funil · Descartado", porque o Lead do HubSpot continuava em Descartado.
-- Vale para as etapas Descartado e DSQ - BR (o painel guarda quando o Lead entrou nelas). Qualificado não muda:
-- não há data de entrada, e lead qualificado continua fora. Etapa sem data de entrada conhecida também não muda.
-- Os números continuam só de SDRs (role = 'sdr'): robôs (Lia) e gestores (Iago) seguem fora, como antes.
create or replace function painel.fora_do_funil(p_lead uuid, p_hubspot_contact_id text)
returns text
language sql
stable
set search_path = ''
as $$
  with tpl as (
    select max(m.sent_at) as em from painel.chat_messages m where m.lead_id = p_lead and m.sender = 'template'
  )
  select coalesce(
    (select v.stage_label
       from painel.contact_hubspot_stage v
       join painel.hubspot_leads h on h.hubspot_lead_id = v.hubspot_lead_id
       cross join tpl
      where p_hubspot_contact_id is not null
        and v.hubspot_contact_id = p_hubspot_contact_id
        and v.stage_id in (select jsonb_array_elements_text(s.value) from painel.settings s where s.key = 'hubspot_excluded_stages')
        and not coalesce(tpl.em > case v.stage_id
              when (select s.value #>> '{}' from painel.settings s where s.key = 'hubspot_stage_descartado') then h.entered_descartado_at
              when (select s.value #>> '{}' from painel.settings s where s.key = 'hubspot_stage_dsq') then h.entered_dsq_at
            end, false)),
    (select n.motivo
       from (select case m.note_tag when 'finalizado' then 'Finalizado (nota)'
                                    when 'dsq' then 'DSQ (nota)'
                                    else 'Descartado (nota)' end as motivo,
                    m.sent_at as em
               from painel.chat_messages m
              where m.lead_id = p_lead and m.note_tag is not null
             union all
             select 'Finalizado (painel)', f.finalized_at
               from painel.lead_finalizacoes f
              where f.lead_id = p_lead and f.undone_at is null
              order by 2 desc
              limit 1) n
      cross join tpl
      where not coalesce(tpl.em > n.em, false)
        and not exists (
        select 1
          from painel.hubspot_leads h
         where p_hubspot_contact_id is not null
           and h.hubspot_contact_id = p_hubspot_contact_id
           and h.created_at > n.em
           and h.stage_id not in (
             select jsonb_array_elements_text(s.value) from painel.settings s where s.key = 'hubspot_excluded_stages'
           )
      ))
  );
$$;
