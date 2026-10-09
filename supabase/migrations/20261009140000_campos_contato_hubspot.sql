-- Campos do Contato e dos Negócios no HubSpot passam para o painel (decisões do Felipe, 2026-10-09).
-- Antes quem gravava era a integração PoliChat-Hubspot (HUBSPOT_FIELDS_ENABLED); ela continua criando as
-- Communications. Os nomes internos ficam iguais (há listas e visões no HubSpot usando).
--
-- Contato: poli_ultima_mensagem_em, poli_direcao_ultima_mensagem (RECEBIDA | ENVIADA),
--   poli_aguardando_resposta (true quando a última mensagem é do lead; regra da integração mantida),
--   id_do_contato_na_poli, link_do_chat_na_poli e os 4 do ciclo de prospecção.
-- Ciclo (regra do painel para a 1ª resposta): recomeça com nota de descarte, DSQ ou "0" (finalizado) na Poli,
--   ou entrada do Lead em Descartado ou DSQ - BR no HubSpot. Início = primeiro template do ciclo (SDR, app token
--   ou n8n); resposta = primeira mensagem do lead depois; horas corridas, 1 casa. Sem template no ciclo (inbound
--   ou ciclo novo ainda sem template): os campos do ciclo não são mexidos.
-- O painel só tem mensagens desde 01/10/2026: os campos do ciclo só são gravados quando o ciclo foi visto
--   inteiro (contato sem mensagem antes disso em public.messages, ou ciclo recomeçado depois).
-- Negócios abertos: os 4 do ciclo sempre que mudarem; link_do_chat_na_poli só quando estiver vazio.

-- Fila e último valor gravado, por contato do HubSpot.
create table painel.hubspot_contato_campos (
  hubspot_contact_id text primary key,
  sujo boolean not null default true,              -- precisa recalcular e gravar
  marcado_em timestamptz not null default now(),   -- última vez que ficou sujo
  valores jsonb,                                   -- o que o painel gravou no Contato
  negocios_valores jsonb,                          -- o ciclo que o painel gravou nos Negócios
  escrito_em timestamptz
);
create index hubspot_contato_campos_sujo_idx on painel.hubspot_contato_campos (marcado_em) where sujo;
alter table painel.hubspot_contato_campos enable row level security;
grant all on painel.hubspot_contato_campos to service_role;

create function painel.marcar_contato_sujo(p_contact text)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into painel.hubspot_contato_campos (hubspot_contact_id) values (p_contact)
  on conflict (hubspot_contact_id) do update set sujo = true, marcado_em = now();
$$;
revoke execute on function painel.marcar_contato_sujo(text) from public, anon, authenticated;

-- Gatilhos: mensagem nova, contato ligado ao lead e entrada em Descartado/DSQ deixam o contato sujo.
create function painel.tg_contato_sujo_mensagem()
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
revoke execute on function painel.tg_contato_sujo_mensagem() from public, anon, authenticated;
create trigger chat_messages_contato_sujo after insert on painel.chat_messages
  for each row execute function painel.tg_contato_sujo_mensagem();

create function painel.tg_contato_sujo_lead()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.hubspot_contact_id is not null and new.hubspot_contact_id is distinct from old.hubspot_contact_id then
    perform painel.marcar_contato_sujo(new.hubspot_contact_id);
  end if;
  return null;
end;
$$;
revoke execute on function painel.tg_contato_sujo_lead() from public, anon, authenticated;
create trigger leads_contato_sujo after update of hubspot_contact_id on painel.leads
  for each row execute function painel.tg_contato_sujo_lead();

create function painel.tg_contato_sujo_hubspot_lead()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.hubspot_contact_id is not null
     and (tg_op = 'INSERT' and (new.entered_descartado_at is not null or new.entered_dsq_at is not null)
          or tg_op = 'UPDATE' and (new.entered_descartado_at is distinct from old.entered_descartado_at
                                   or new.entered_dsq_at is distinct from old.entered_dsq_at)) then
    perform painel.marcar_contato_sujo(new.hubspot_contact_id);
  end if;
  return null;
end;
$$;
revoke execute on function painel.tg_contato_sujo_hubspot_lead() from public, anon, authenticated;
create trigger hubspot_leads_contato_sujo after insert or update on painel.hubspot_leads
  for each row execute function painel.tg_contato_sujo_hubspot_lead();

-- Valores atuais dos campos de um contato (texto no formato do HubSpot: data em milissegundos).
-- Campos do ciclo ausentes = não mexer.
create function painel.campos_contato(p_contact text)
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
  where l.hubspot_contact_id = p_contact and m.sender <> 'system'
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
  where l.hubspot_contact_id = p_contact and m.sender = 'lead' and m.sent_at > v_start.sent_at;

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

-- Contatos sujos com os valores atuais e os últimos gravados (para o worker gravar só o que mudou).
create function painel.contatos_hubspot_pendentes(p_limit integer default 100)
returns table (hubspot_contact_id text, marcado_em timestamptz, atual jsonb, anterior jsonb, negocios_anterior jsonb)
language sql
stable
security definer
set search_path = ''
as $$
  select c.hubspot_contact_id, c.marcado_em, painel.campos_contato(c.hubspot_contact_id), c.valores, c.negocios_valores
  from painel.hubspot_contato_campos c
  where c.sujo
  order by c.marcado_em
  limit greatest(coalesce(p_limit, 100), 1);
$$;
revoke execute on function painel.contatos_hubspot_pendentes(integer) from public, anon, authenticated;
grant execute on function painel.contatos_hubspot_pendentes(integer) to service_role;

-- Primeira carga: todo contato do HubSpot com mensagem no painel.
insert into painel.hubspot_contato_campos (hubspot_contact_id)
select distinct l.hubspot_contact_id
from painel.leads l
where l.hubspot_contact_id is not null
  and exists (select 1 from painel.chat_messages m where m.lead_id = l.id)
on conflict do nothing;
