-- Fase 9b — SDR Modelo, um SDR: exemplos de conversas de cada comportamento (docs/sdr-modelo.md §4).
-- "A melhorar" = até 3 casos piores; "Bom exemplo" = 1 caso melhor, no período. Só nome do lead e o link do Poli
-- (poli_contact_uuid), sem telefone nem texto de mensagem (LGPD).
--   pri / res: a 1ª resposta / resposta mais lenta e a mais rápida (mesmos blocos e filtro de horário das medianas).
--   val: reuniões invalidadas ou no show × a validada mais recente.
--   conf: reuniões sem mensagem da equipe nos 60 min antes × uma com (reunião marcada menos de 60 min antes fica fora).
--   vol, tax, des: são contagens do período, sem conversa de exemplo.
create or replace function painel.sdr_modelo_exemplos(p_sdr uuid, p_from timestamptz, p_to timestamptz, p_comportamento text)
returns table (tipo text, lead_id uuid, lead_name text, poli_contact_uuid text, quando timestamptz, segundos integer, status text)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_scope uuid := painel.escopo_sdr();   -- só checa o acesso
  v_own uuid;
  v_biz boolean := coalesce((select (s.value #>> '{}')::boolean from painel.settings s where s.key = 'metrics_business_only'), true);
begin
  -- o SDR vê só os próprios exemplos
  select p.sdr_id into v_own from painel.profiles p where p.id = (select auth.uid()) and p.role = 'sdr';
  if v_own is not null and v_own <> p_sdr then
    raise exception 'acesso negado' using errcode = '42501';
  end if;

  if p_comportamento in ('pri', 'res') then
    return query
    with r as (
      select c.lead_id, r.lead_block_started_at, r.seconds_24h
        from painel.response_events r
        join painel.chats c on c.id = r.chat_id
       where r.sdr_id = p_sdr
         and r.lead_block_started_at >= p_from and r.lead_block_started_at < p_to
         and (p_comportamento = 'res' or r.is_first_response)
         and (not v_biz or painel.is_business_time(r.lead_block_started_at))
    ),
    pior as (select 'melhorar'::text t, r.* from r order by r.seconds_24h desc, r.lead_block_started_at limit 3),
    melhor as (select 'bom'::text t, r.* from r where r.lead_id not in (select pior.lead_id from pior)
               order by r.seconds_24h, r.lead_block_started_at limit 1)
    select x.t, x.lead_id, l.name, l.poli_contact_uuid, x.lead_block_started_at, x.seconds_24h, null::text
      from (select * from pior union all select * from melhor) x
      join painel.leads l on l.id = x.lead_id
     order by x.t desc, x.seconds_24h desc;

  elsif p_comportamento in ('val', 'conf') then
    return query
    with m as (
      select m.lead_id, m.starts_at, m.status::text st,
             exists (select 1 from painel.chat_messages x
                      where x.lead_id = m.lead_id and x.by_human
                        and x.sent_at >= m.starts_at - interval '60 minutes' and x.sent_at < m.starts_at) as confirmou
        from painel.meetings m
       where m.sdr_id = p_sdr and m.starts_at >= p_from and m.starts_at < p_to and m.excluida_at is null
         and m.status in ('validada', 'invalidada', 'noshow')
         and (p_comportamento = 'val' or m.created_at < m.starts_at - interval '60 minutes')
    ),
    pior as (select 'melhorar'::text t, m.* from m
              where case when p_comportamento = 'val' then m.st <> 'validada' else not m.confirmou end
              order by m.starts_at desc limit 3),
    melhor as (select 'bom'::text t, m.* from m
                where case when p_comportamento = 'val' then m.st = 'validada' else m.confirmou end
                order by m.starts_at desc limit 1)
    select x.t, x.lead_id, l.name, l.poli_contact_uuid, x.starts_at, null::integer,
           case when p_comportamento = 'val' then x.st when x.confirmou then 'confirmou' else 'sem_confirmacao' end
      from (select * from pior union all select * from melhor) x
      join painel.leads l on l.id = x.lead_id
     order by x.t desc, x.starts_at desc;
  end if;
end;
$$;

revoke execute on function painel.sdr_modelo_exemplos(uuid, timestamptz, timestamptz, text) from public, anon;
grant execute on function painel.sdr_modelo_exemplos(uuid, timestamptz, timestamptz, text) to authenticated, service_role;
