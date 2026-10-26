-- Resposta automática do lead fora dos campos do HubSpot (decisão do Felipe, 2026-10-26).
-- Desde 2026-10-16 o painel não conta resposta automática (robô do lado do lead, chat_messages.auto_reply), mas os
-- campos enviados ao HubSpot ainda contavam: "Respondeu template" do Lead (lido pelo follow-up do n8n),
-- "Aguardando resposta"/"Direção da última mensagem" e "Primeira resposta em"/"Tempo até a resposta" do Contato.
-- Em 26/10, 1.164 dos 2.457 Leads marcados desde 16/10 tinham só resposta automática.
-- Mesma regra de antes, ignorando mensagens com auto_reply. Não desmarca o que já foi marcado.

create or replace function painel.campos_contato(p_contact text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_inicio_dados constant timestamptz := '2026-10-01T10:00:00Z';  -- primeiro evento da Poli no painel
  v_last record;
  v_poli text;
  v_reset timestamptz;
  v_start record;
  v_reply timestamptz;
  v_out jsonb;
begin
  select m.sent_at, m.sender::text as sender into v_last
  from painel.chat_messages m join painel.leads l on l.id = m.lead_id
  where l.hubspot_contact_id = p_contact and m.sender <> 'system' and not m.auto_reply
  order by m.sent_at desc, m.id desc limit 1;
  if v_last.sent_at is null then
    return null;
  end if;

  -- contato da Poli: o lead do painel com a mensagem mais recente
  select l.poli_contact_uuid into v_poli
  from painel.leads l join painel.chat_messages m on m.lead_id = l.id
  where l.hubspot_contact_id = p_contact and l.poli_contact_uuid is not null
  order by m.sent_at desc limit 1;

  v_out := jsonb_build_object(
    'poli_ultima_mensagem_em', (round(extract(epoch from v_last.sent_at) * 1000))::bigint::text,
    'poli_direcao_ultima_mensagem', case when v_last.sender = 'lead' then 'RECEBIDA' else 'ENVIADA' end,
    'poli_aguardando_resposta', case when v_last.sender = 'lead' then 'true' else 'false' end
  );
  if v_poli is not null then
    v_out := v_out || jsonb_build_object('id_do_contato_na_poli', v_poli,
                                         'link_do_chat_na_poli', 'https://app.poli.digital/chat/' || v_poli);
  end if;

  -- ciclo: último recomeço (nota de descarte/DSQ/finalizado ou entrada em Descartado/DSQ no HubSpot)
  select max(x.at) into v_reset from (
    select m.sent_at as at from painel.chat_messages m join painel.leads l on l.id = m.lead_id
     where l.hubspot_contact_id = p_contact and m.note_tag is not null
    union all
    select h.entered_descartado_at from painel.hubspot_leads h where h.hubspot_contact_id = p_contact
    union all
    select h.entered_dsq_at from painel.hubspot_leads h where h.hubspot_contact_id = p_contact
  ) x;

  -- só grava o ciclo se o painel viu o ciclo inteiro
  if not (coalesce(v_reset >= v_inicio_dados, false)
          or not exists (select 1 from public.messages pm
                          where pm.hubspot_contact_id = p_contact and pm.sent_at < v_inicio_dados)) then
    return v_out;
  end if;

  select m.sent_at, m.template_name into v_start
  from painel.chat_messages m join painel.leads l on l.id = m.lead_id
  where l.hubspot_contact_id = p_contact and m.sender = 'template'
    and m.sent_at > coalesce(v_reset, '-infinity'::timestamptz)
  order by m.sent_at, m.id limit 1;
  if v_start.sent_at is null then
    return v_out;   -- ciclo sem template (inbound ou ainda não abriu): não mexe nos campos do ciclo
  end if;

  select min(m.sent_at) into v_reply
  from painel.chat_messages m join painel.leads l on l.id = m.lead_id
  where l.hubspot_contact_id = p_contact and m.sender = 'lead' and not m.auto_reply
    and m.sent_at > v_start.sent_at;

  return v_out || jsonb_build_object(
    'poli_prospeccao_iniciada_em', (round(extract(epoch from v_start.sent_at) * 1000))::bigint::text,
    'poli_template_da_prospeccao', coalesce(v_start.template_name, ''),
    'poli_primeira_resposta_em', coalesce((round(extract(epoch from v_reply) * 1000))::bigint::text, ''),
    'poli_tempo_ate_resposta_horas', coalesce(round((extract(epoch from v_reply - v_start.sent_at) / 3600)::numeric, 1)::text, '')
  );
end;
$$;
revoke execute on function painel.campos_contato(text) from public, anon, authenticated;
grant execute on function painel.campos_contato(text) to service_role;

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
    where m.sender = 'lead' and not m.auto_reply
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


-- auto_reply é marcado depois da gravação da mensagem: quando muda, o contato fica sujo para regravar os campos.
create or replace function painel.tg_contato_sujo_auto_reply()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_contact text;
begin
  select l.hubspot_contact_id into v_contact from painel.leads l where l.id = new.lead_id;
  if v_contact is not null then
    perform painel.marcar_contato_sujo(v_contact);
  end if;
  return null;
end;
$$;
revoke execute on function painel.tg_contato_sujo_auto_reply() from public, anon, authenticated;
create trigger chat_messages_contato_sujo_auto_reply after update of auto_reply on painel.chat_messages
  for each row when (old.auto_reply is distinct from new.auto_reply)
  execute function painel.tg_contato_sujo_auto_reply();

-- Regrava os campos do Contato de quem teve resposta automática desde 16/10 (Aguardando, direção, primeira resposta).
select painel.marcar_contato_sujo(x.hubspot_contact_id)
from (select distinct l.hubspot_contact_id
        from painel.chat_messages m join painel.leads l on l.id = m.lead_id
       where m.auto_reply and m.sent_at >= '2026-10-16' and l.hubspot_contact_id is not null) x;
