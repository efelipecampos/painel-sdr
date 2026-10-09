-- "Respondeu template" no Lead do HubSpot (decisão do Felipe, 2026-10-09).
-- O fluxo de follow-up do n8n só manda mensagem para Lead com `respondeu_template` desmarcado. Antes o SDR
-- marcava à mão e esquecia; agora o worker marca sozinho quando o lead escreve qualquer mensagem
-- (texto, áudio, "ok", resposta automática do WhatsApp Business), em resposta a template do n8n, do SDR ou do robô.
-- Regras: só marca, nunca desmarca; marca o Lead do ciclo em que o lead respondeu (mensagem depois da criação do
-- Lead anterior do mesmo contato e no máximo 1 dia antes da criação deste, para pegar o lead que escreveu e o
-- Lead foi criado logo em seguida). Os Leads abertos que já tinham resposta são marcados na primeira rodada.

alter table painel.hubspot_leads
  add column respondeu_template boolean,          -- valor no HubSpot (sync dos Leads)
  add column respondeu_marcado_at timestamptz;    -- quando o painel marcou (null = o painel não marcou)

-- Leads do HubSpot que precisam ser marcados: campo desmarcado no HubSpot, painel ainda não marcou e o lead
-- escreveu no ciclo deste Lead. Devolve também a primeira mensagem do lead no ciclo (para o registro).
create function painel.leads_para_marcar_resposta(p_limit integer default 100)
returns table (hubspot_lead_id text, hubspot_contact_id text, respondeu_em timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select h.hubspot_lead_id, h.hubspot_contact_id, r.em
  from painel.hubspot_leads h
  cross join lateral (
    select min(m.sent_at) as em
    from painel.leads l
    join painel.chat_messages m on m.lead_id = l.id and m.sender = 'lead'
    where l.hubspot_contact_id = h.hubspot_contact_id
      and m.sent_at >= h.created_at - interval '1 day'
      and m.sent_at > coalesce((select max(h2.created_at) from painel.hubspot_leads h2
                                 where h2.hubspot_contact_id = h.hubspot_contact_id
                                   and h2.created_at < h.created_at), '-infinity'::timestamptz)
  ) r
  where h.hubspot_contact_id is not null
    and h.created_at is not null
    and h.respondeu_template is not true
    and h.respondeu_marcado_at is null
    and r.em is not null
  order by r.em
  limit greatest(coalesce(p_limit, 100), 1);
$$;
revoke execute on function painel.leads_para_marcar_resposta(integer) from public, anon, authenticated;
grant execute on function painel.leads_para_marcar_resposta(integer) to service_role;
