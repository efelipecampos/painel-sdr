-- Fase 10a (1/2): papel "sdr" para os SDRs entrarem no painel.
-- Arquivo separado: o Postgres não deixa usar um valor novo de enum na mesma transação em que ele é criado.
alter type painel.app_role add value if not exists 'sdr';
