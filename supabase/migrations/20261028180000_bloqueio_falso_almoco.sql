-- Bloqueio falso na agenda do closer (decisão do Felipe, 2026-10-28; especificação da sessão a4). O painel passa a
-- ignorar bloco sem convidado na agenda do Google (só reunião com convidado, interna ou de cliente, e "Fora do
-- escritório" ocupam). O almoço, que era um evento sem convidado na agenda de cada closer, vira configuração do
-- painel por closer: padrão 12:00 às 13:15, editável por gestor/admin na tela Usuários.
alter table painel.sdrs
  add column almoco_inicio time not null default '12:00',
  add column almoco_fim time not null default '13:15',
  add constraint sdrs_almoco_chk check (almoco_fim > almoco_inicio);
