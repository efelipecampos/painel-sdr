-- Painel lento (2026-10-20): painel.leads_para_marcar_resposta roda a cada rodada do worker (30 s) e, para cada um
-- dos ~16 mil Leads ainda desmarcados, procurava as mensagens do contato uma a uma (0,3 a 1,4 s por chamada; foi a
-- primeira consulta a estourar o limite nas quedas de 20/10). Mesma regra de 2026-10-09, calculada em bloco:
-- as mensagens do lead dos contatos pendentes uma vez só, juntadas aos Leads pelo contato e pela janela do ciclo.
-- Conferida em produção contra a versão antiga em todos os Leads (3.087 com resposta): 0 diferenças.
create or replace function painel.leads_para_marcar_resposta(p_limit integer default 100)
returns table (hubspot_lead_id text, hubspot_contact_id text, respondeu_em timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  with pend as materialized (
    select h.hubspot_lead_id, h.hubspot_contact_id, h.created_at,
           (select max(h2.created_at) from painel.hubspot_leads h2
             where h2.hubspot_contact_id = h.hubspot_contact_id and h2.created_at < h.created_at) as anterior
    from painel.hubspot_leads h
    where h.hubspot_contact_id is not null
      and h.created_at is not null
      and h.respondeu_template is not true
      and h.respondeu_marcado_at is null
  ),
  msg as materialized (
    select l.hubspot_contact_id, m.sent_at
    from painel.chat_messages m
    join painel.leads l on l.id = m.lead_id
    where m.sender = 'lead'
      and l.hubspot_contact_id in (select pend.hubspot_contact_id from pend)
  )
  select p.hubspot_lead_id, p.hubspot_contact_id, min(m.sent_at) as em
  from pend p
  join msg m on m.hubspot_contact_id = p.hubspot_contact_id
            and m.sent_at >= p.created_at - interval '1 day'
            and m.sent_at > coalesce(p.anterior, '-infinity'::timestamptz)
  group by p.hubspot_lead_id, p.hubspot_contact_id
  order by em
  limit greatest(coalesce(p_limit, 100), 1);
$$;
