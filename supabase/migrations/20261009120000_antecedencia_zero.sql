-- Antecedência mínima para agendar: 0 h por padrão (decisão do Felipe, 2026-10-09; era 2 h).
-- Só muda o padrão de carrossel novo. Os carrosséis que já existem o Felipe zera pela tela Carrosséis.
alter table painel.carousels alter column min_notice_minutes set default 0;
