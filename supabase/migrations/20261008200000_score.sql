-- Fase 7b: score de qualidade do lead (Claude) e carteira por SDR.
-- Decisões do Felipe (07/10/2026):
--  * critérios e pesos iniciais abaixo (editáveis depois); contexto da Poli abaixo;
--  * só avalia lead com 2+ mensagens escritas por ele, em conversa com SDR como responsável; quem já é cliente fica
--    sem nota; critério sem informação fica fora da média (calculado no worker, apps/worker/src/score);
--  * carteira = Lead mais recente do contato no [New] Pipeline SDR, em etapa aberta, com o SDR como dono;
--    qualidade da carteira = média das notas dos leads avaliados; quem nunca respondeu ou ficou abaixo do corte
--    aparece à parte, como "sem avaliação".
-- sdr_metrics e team_metrics NÃO mudam: a carteira tem a própria função (painel.carteira).

-- 1. Critérios e contexto iniciais
insert into painel.quality_criteria (name, description, weight, sort) values
  ('Engajamento', 'Conversa de verdade: várias mensagens, áudios, responde às perguntas do SDR. Nota baixa para 1 ou 2 mensagens curtas, silêncio depois do primeiro contato ou resposta automática do WhatsApp Business.', 3, 1),
  ('Porte', 'Equipe de 3 ou mais pessoas atendendo clientes, setores, diretoria, fluxo de atendimento, CNPJ. Nota baixa para autônomo, "atendo sozinho" ou menos de 3 usuários.', 3, 2),
  ('Dor de atendimento', 'Descreve um problema de atendimento que a Poli resolve: desorganização, demora para responder, conversas perdidas, falta de controle sobre o time, vários números.', 2, 3),
  ('Intenção de avançar', 'Pede reunião, proposta ou preço, aceita agendar. Nota baixa quando pede para encerrar, diz que não pediu contato ou some.', 2, 4),
  ('Encaixe no produto', 'Quer atendimento com vários atendentes pelo WhatsApp. Nota baixa quando procura só disparo em massa, catálogo ou divulgação.', 2, 5);

insert into painel.settings (key, value) values
  ('quality_context', to_jsonb('A Poli Digital vende uma plataforma de atendimento pelo WhatsApp para empresas: vários atendentes no mesmo número, distribuição de conversas entre setores, chatbot e integração com CRM. O cliente ideal é uma empresa com 3 ou mais pessoas atendendo clientes pelo WhatsApp, que hoje sofre com desorganização, demora para responder, perda de conversas ou falta de controle sobre o time. A Poli não vende para quem tem menos de 3 usuários nem para autônomos. Ela também não é ferramenta de disparo em massa, catálogo ou divulgação. A Poli funciona no computador, não em aplicativo de celular. O objetivo do SDR é qualificar o lead e marcar uma reunião com o closer.'::text)),
  -- Etapas do [New] Pipeline SDR que tiram o lead da carteira (o HubSpot não marca etapa aberta/fechada neste pipeline):
  -- Qualificado, Descartado e DSQ - BR.
  ('hubspot_carteira_fora_stages', '["1358962969", "1250901141", "1250901142"]')
on conflict (key) do nothing;

-- 2. painel.lead_scores: guarda também quem ficou sem nota, para não ser reavaliado até o lead escrever de novo.
--    status: avaliado | sem_informacao (nenhum critério com informação) | ja_e_cliente | abaixo_do_corte
alter table painel.lead_scores alter column score drop not null;
alter table painel.lead_scores alter column model drop not null;
alter table painel.lead_scores add column status text not null default 'avaliado'
  check (status in ('avaliado', 'sem_informacao', 'ja_e_cliente', 'abaixo_do_corte'));
alter table painel.lead_scores add constraint lead_scores_score_status check ((status = 'avaliado') = (score is not null));

-- 3. Leads a avaliar (worker). Candidato: o lead escreveu depois da última avaliação feita com esta versão dos
--    critérios (ou nunca foi avaliado com ela), a conversa está parada há p_idle_minutes, e o responsável pelo
--    chat mais recente é um SDR (não closer, gestor nem robô). Os mais recentes primeiro.
create function painel.score_candidatos(p_version text, p_limit integer, p_idle_minutes integer default 60)
returns table (lead_id uuid, last_lead_message_at timestamptz)
language sql
stable
set search_path = ''
as $$
  with ult as (
    select m.lead_id,
           max(m.sent_at) filter (where m.sender = 'lead') as last_lead,
           max(m.sent_at) as last_any
    from painel.chat_messages m
    group by m.lead_id
  ),
  chat_atual as (
    select distinct on (c.lead_id) c.lead_id, c.sdr_id
    from painel.chats c
    order by c.lead_id, c.opened_at desc
  ),
  avaliado as (
    select s.lead_id, max(s.based_on_message_at) as ate
    from painel.lead_scores s
    where s.criteria_version = p_version
    group by s.lead_id
  )
  select u.lead_id, u.last_lead
  from ult u
  join chat_atual ca on ca.lead_id = u.lead_id
  join painel.sdrs sd on sd.id = ca.sdr_id and sd.role = 'sdr' and not sd.is_bot
  left join avaliado a on a.lead_id = u.lead_id
  where u.last_lead is not null
    and u.last_any <= now() - make_interval(mins => p_idle_minutes)
    and (a.ate is null or a.ate < u.last_lead)
  order by u.last_lead desc
  limit p_limit;
$$;
revoke execute on function painel.score_candidatos(text, integer, integer) from public, anon, authenticated;
grant execute on function painel.score_candidatos(text, integer, integer) to service_role;

-- 4. Carteira e qualidade da carteira, por SDR (estado atual, sem período).
--    Respeita o escopo: o SDR logado só vê a própria linha; gestor e admin veem todos e a linha do time
--    (sdr_id null), que soma todo mundo, inclusive desativados. A lista por SDR mostra só os ativos.
create function painel.carteira()
returns table (sdr_id uuid, carteira integer, avaliados integer, sem_avaliacao integer, qualidade integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_scope uuid := painel.escopo_sdr();  -- levanta 'acesso negado' para quem não pode
  v_pipe text := (select s.value #>> '{}' from painel.settings s where s.key = 'hubspot_pipeline_sdr');
  v_fora text[] := coalesce((select array(select jsonb_array_elements_text(s.value)) from painel.settings s
                             where s.key = 'hubspot_carteira_fora_stages'), '{}');
begin
  return query
  with ult as (
    -- Lead mais recente de cada contato no pipeline do SDR
    select distinct on (h.hubspot_contact_id) h.hubspot_contact_id, h.stage_id, h.owner_id
    from painel.hubspot_leads h
    where h.pipeline_id = v_pipe and h.hubspot_contact_id is not null
    order by h.hubspot_contact_id, h.created_at desc nulls last
  ),
  cart as (
    select sd.id as sdr_id, sd.active, u.hubspot_contact_id
    from ult u
    join painel.hubspot_owners o on o.owner_id = u.owner_id
    join painel.sdrs sd on lower(sd.poli_email) = lower(o.email) and sd.role = 'sdr'
    where not (u.stage_id = any (v_fora))
      and (v_scope is null or sd.id = v_scope)
  ),
  nota as (
    -- última avaliação de cada contato (o contato pode ter mais de um lead na Poli: vale a mais recente)
    select distinct on (l.hubspot_contact_id) l.hubspot_contact_id, s.status, s.score
    from painel.leads l
    join painel.lead_scores s on s.lead_id = l.id
    where l.hubspot_contact_id in (select cart.hubspot_contact_id from cart)
    order by l.hubspot_contact_id, s.scored_at desc, s.id desc
  ),
  por as (
    select cart.sdr_id, cart.active,
           count(*) as n,
           count(*) filter (where nota.status = 'avaliado') as av,
           round(avg(nota.score) filter (where nota.status = 'avaliado')) as q
    from cart left join nota on nota.hubspot_contact_id = cart.hubspot_contact_id
    group by cart.sdr_id, cart.active
  )
  select por.sdr_id, por.n::integer, por.av::integer, (por.n - por.av)::integer, por.q::integer
  from por
  where por.active
  union all
  select null::uuid, sum(por.n)::integer, sum(por.av)::integer, sum(por.n - por.av)::integer,
         round(sum(por.q * por.av) / nullif(sum(por.av), 0))::integer
  from por
  having v_scope is null;
end;
$$;
revoke execute on function painel.carteira() from public, anon;
grant execute on function painel.carteira() to authenticated, service_role;

-- 5. Nota mais recente de cada lead da lista (tela do SDR), com a justificativa por critério.
--    O SDR logado só recebe leads que estão (ou estiveram) com ele.
create function painel.lead_notas(p_leads uuid[])
returns table (lead_id uuid, status text, score integer, summary text, criteria_scores jsonb, scored_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_scope uuid := painel.escopo_sdr();
begin
  return query
  select distinct on (s.lead_id) s.lead_id, s.status, s.score, s.summary,
         (select coalesce(jsonb_agg(jsonb_build_object('criterio', q.name, 'peso', q.weight,
                                                       'nota', cs ->> 'score', 'justificativa', cs ->> 'justificativa')
                                    order by q.sort), '[]'::jsonb)
          from jsonb_array_elements(s.criteria_scores) cs
          left join painel.quality_criteria q on q.id::text = cs ->> 'criterion_id'),
         s.scored_at
  from painel.lead_scores s
  where s.lead_id = any (p_leads)
    and (v_scope is null or exists (select 1 from painel.chats c where c.lead_id = s.lead_id and c.sdr_id = v_scope))
  order by s.lead_id, s.scored_at desc, s.id desc;
end;
$$;
revoke execute on function painel.lead_notas(uuid[]) from public, anon;
grant execute on function painel.lead_notas(uuid[]) to authenticated, service_role;
