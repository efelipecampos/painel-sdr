-- Revisão de segurança (Fase 8, 2026-10-09): carrossel_outra_marca não conferia se o usuário está ativo.
-- Só o servidor chama (Passar para CH/Poli, com a service_role), então o usuário logado deixa de poder chamar.
revoke execute on function painel.carrossel_outra_marca(uuid) from authenticated;
