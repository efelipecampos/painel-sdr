-- Finalizar lead à mão (decisão do Felipe, 2026-10-08).
-- Para quando a nota interna "0" (Finalizado) escrita na Poli não chega ao painel: a Poli às vezes não manda o evento.
-- Mesmo efeito da nota: o lead sai de "Aguardando" e "Parados" (continua nos tempos de resposta) e só volta quando
-- existir no HubSpot um Lead do contato criado depois da finalização e fora das etapas excluídas. Pode ser desfeito.
-- Quem pode: admin, gestor e SDR ativos (acesso global do SDR, 2026-10-08).

create table painel.lead_finalizacoes (
  id bigint generated always as identity primary key,
  lead_id uuid not null references painel.leads,
  finalized_at timestamptz not null default now(),
  finalized_by uuid not null references auth.users,
  undone_at timestamptz,
  undone_by uuid references auth.users
);
-- no máximo uma finalização ativa por lead
create unique index lead_finalizacoes_ativa_uidx on painel.lead_finalizacoes (lead_id) where undone_at is null;
alter table painel.lead_finalizacoes enable row level security;
-- sem acesso direto do navegador: só pelas funções abaixo
grant all on painel.lead_finalizacoes to service_role;

-- Motivo de o lead estar fora de "Aguardando"/"Parados": etapa do HubSpot, nota interna mais recente ou
-- finalização à mão. Nota e finalização seguem a mesma regra de volta (Lead novo no HubSpot depois da marcação).
create or replace function painel.fora_do_funil(p_lead uuid, p_hubspot_contact_id text)
returns text
language sql
stable
set search_path = ''
as $$
  select coalesce(
    painel.hubspot_excluded_stage(p_hubspot_contact_id),
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
      where not exists (
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

-- Finaliza (p_finalizar = true) ou desfaz a finalização ativa (false). Idempotente.
create function painel.finalizar_lead(p_lead uuid, p_finalizar boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not painel.pode_ver_tudo() then
    raise exception 'acesso negado' using errcode = '42501';
  end if;
  if not exists (select 1 from painel.leads where id = p_lead) then
    raise exception 'lead não encontrado' using errcode = 'P0002';
  end if;
  if p_finalizar then
    insert into painel.lead_finalizacoes (lead_id, finalized_by)
    values (p_lead, (select auth.uid()))
    on conflict (lead_id) where undone_at is null do nothing;
  else
    update painel.lead_finalizacoes
       set undone_at = now(), undone_by = (select auth.uid())
     where lead_id = p_lead and undone_at is null;
  end if;
end;
$$;
revoke execute on function painel.finalizar_lead(uuid, boolean) from public, anon;
grant execute on function painel.finalizar_lead(uuid, boolean) to authenticated, service_role;
