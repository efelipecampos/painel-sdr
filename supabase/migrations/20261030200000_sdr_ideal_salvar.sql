-- Fase 9b — SDR Ideal (configuração): salvar cria uma versão nova, com data e autor (docs/sdr-modelo.md §3).
-- Só gestor e admin. A tela manda a lista inteira de comportamentos e a versão em que a edição começou: se outra
-- pessoa salvou no meio, recusa (para ninguém apagar a mudança do outro sem ver).
-- Regras (design/SDRIdeal.dc.html): pesos dos ativos somam 100; "de" não passa do "até"; comportamento de conversa
-- ativo precisa dizer o que a IA olha; comportamento de número só os que têm cálculo no banco.
create or replace function painel.salvar_sdr_ideal(p_base_versao integer, p_comportamentos jsonb, p_mudancas text[])
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_atual integer;
  v_nova integer;
  v_soma numeric;
  c jsonb;
  v_ids text[] := '{}';
begin
  if not painel.is_manager() then
    raise exception 'acesso negado' using errcode = '42501';
  end if;
  if jsonb_typeof(p_comportamentos) <> 'array' or jsonb_array_length(p_comportamentos) = 0 then
    raise exception 'Lista de comportamentos vazia.';
  end if;
  if coalesce(array_length(p_mudancas, 1), 0) = 0 then
    raise exception 'Nenhuma mudança para salvar.';
  end if;

  -- uma edição por vez
  lock table painel.sdr_ideal_versoes in exclusive mode;
  select max(v.versao) into v_atual from painel.sdr_ideal_versoes v;
  if v_atual is distinct from p_base_versao then
    raise exception 'Outra pessoa salvou a versão % enquanto você editava. Recarregue a página e refaça a mudança.', v_atual;
  end if;

  for c in select * from jsonb_array_elements(p_comportamentos) loop
    if coalesce(c ->> 'id', '') = '' or (c ->> 'id') = any (v_ids) then
      raise exception 'Comportamento sem identificador ou repetido.';
    end if;
    v_ids := v_ids || (c ->> 'id');
    if coalesce(c ->> 'grupo', '') not in ('num', 'ia') then
      raise exception 'Grupo inválido em %.', c ->> 'nome';
    end if;
    if c ->> 'grupo' = 'num' and (c ->> 'id') not in ('vol', 'pri', 'res', 'tax', 'des', 'val', 'conf') then
      raise exception 'Comportamento de número novo precisa de código: %.', c ->> 'nome';
    end if;
    if coalesce(trim(c ->> 'nome'), '') = '' or char_length(c ->> 'nome') > 80 then
      raise exception 'Todo comportamento precisa de nome (até 80 letras).';
    end if;
    if c ->> 'grupo' = 'ia' and coalesce((c ->> 'ativo')::boolean, false) and coalesce(trim(c ->> 'descricao'), '') = '' then
      raise exception 'Falta escrever o que a IA olha em %.', c ->> 'nome';
    end if;
    if char_length(coalesce(c ->> 'descricao', '')) > 1000 then
      raise exception 'O que a IA olha em % passa de 1000 letras.', c ->> 'nome';
    end if;
    if jsonb_typeof(c -> 'lo') = 'number' and jsonb_typeof(c -> 'hi') = 'number' and (c ->> 'lo')::numeric > (c ->> 'hi')::numeric then
      raise exception 'A faixa de % está com o "de" maior que o "até".', c ->> 'nome';
    end if;
    if coalesce((c ->> 'melhor')::integer, 9) not in (-1, 0, 1) then
      raise exception 'Lado melhor inválido em %.', c ->> 'nome';
    end if;
    if jsonb_typeof(c -> 'peso') <> 'number' or (c ->> 'peso')::numeric < 0 then
      raise exception 'Peso inválido em %.', c ->> 'nome';
    end if;
  end loop;

  select coalesce(sum((x ->> 'peso')::numeric), 0) into v_soma
    from jsonb_array_elements(p_comportamentos) x where coalesce((x ->> 'ativo')::boolean, false);
  if v_soma <> 100 then
    raise exception 'Os pesos dos comportamentos ativos somam %. Precisam somar 100.', v_soma;
  end if;

  v_nova := coalesce(v_atual, 0) + 1;
  insert into painel.sdr_ideal_versoes (versao, created_by, origem, mudancas, comportamentos)
  values (v_nova, (select auth.uid()), 'edicao', p_mudancas[1:50], p_comportamentos);
  return v_nova;
end;
$$;

revoke execute on function painel.salvar_sdr_ideal(integer, jsonb, text[]) from public, anon;
grant execute on function painel.salvar_sdr_ideal(integer, jsonb, text[]) to authenticated, service_role;
