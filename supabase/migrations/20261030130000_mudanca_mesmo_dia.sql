-- Mudança de horário no mesmo dia com o mesmo closer, feita pela SDR (decisão do Felipe, 2026-10-30): o histórico
-- de mudanças passa a dizer o tipo e o motivo. As mudanças antigas ficam com tipo e motivo vazios.
alter table painel.meeting_changes
  add column tipo text check (tipo in ('mesmo_dia')),
  add column motivo text check (char_length(motivo) <= 1000);

comment on column painel.meeting_changes.tipo is 'mesmo_dia: a SDR mudou a reunião de hoje para outro horário de hoje, com o mesmo closer';
comment on column painel.meeting_changes.motivo is 'Motivo escrito por quem mudou (obrigatório no mesmo_dia)';
