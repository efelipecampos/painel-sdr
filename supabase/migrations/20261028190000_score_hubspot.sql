-- Score da IA no HubSpot (2026-10-28, decisão do Felipe): a nota mais recente de cada contato vai para o campo
-- ia_score ("[IA] Score") do Contato toda vez que muda. Só avaliação com nota (status 'avaliado'); abaixo do corte,
-- já é cliente e sem informação não mexem no campo (fica a última nota). hubspot_synced_at marca o que já foi.
-- As notas que já existem ficam pendentes: a primeira rodada depois do deploy faz a carga inicial.

alter table painel.lead_scores add column hubspot_synced_at timestamptz;

-- Pendentes: a nota mais recente de cada contato do HubSpot (entre todos os leads do painel desse contato),
-- quando ela ainda não foi enviada. Nota antiga substituída por uma nova nunca vai. Só o servidor.
create function painel.scores_para_hubspot(p_limit integer default 100)
returns table (score_id bigint, hubspot_contact_id text, score integer)
language sql
stable
security definer
set search_path = ''
as $$
  with ultima as (
    select distinct on (l.hubspot_contact_id) s.id, l.hubspot_contact_id::text as hubspot_contact_id, s.score, s.hubspot_synced_at
    from painel.lead_scores s
    join painel.leads l on l.id = s.lead_id
    where s.status = 'avaliado' and l.hubspot_contact_id is not null
    order by l.hubspot_contact_id, s.scored_at desc, s.id desc
  )
  select u.id, u.hubspot_contact_id, u.score
  from ultima u
  where u.hubspot_synced_at is null
  order by u.id
  limit p_limit;
$$;
revoke execute on function painel.scores_para_hubspot(integer) from public, anon, authenticated;
grant execute on function painel.scores_para_hubspot(integer) to service_role;
