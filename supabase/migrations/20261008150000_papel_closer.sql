-- Fase 10c (1/2): papel closer no painel (o closer conecta a própria agenda pela tela dele).
-- Separado do resto porque um valor novo de enum não pode ser usado na mesma transação em que é criado.
alter type painel.app_role add value if not exists 'closer';
