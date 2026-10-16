-- Painel lento (2026-10-16): a integração PoliChat-Hubspot pergunta, a cada evento da Poli, se o atendimento já tem
-- evento gravado (src/supabase/rawEvents.ts, attendanceHasRawEvent):
--   GET /raw_events?select=id&source=eq.poli_webhook&payload->value->attendance->>uuid=eq.<uuid>&limit=1
-- Sem índice, cada pergunta lia a tabela inteira (média de 2,1 s) e disputava o banco com as telas.
-- Só um índice: nenhuma coluna muda, o contrato com a integração continua igual.
create index if not exists raw_events_attendance_uuid_idx
  on public.raw_events (source, ((payload -> 'value' -> 'attendance') ->> 'uuid'));
