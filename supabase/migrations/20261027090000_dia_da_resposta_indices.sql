-- Dia da resposta lento (2026-10-27): painel.leads_para_marcar_dia levou 7 s na primeira rodada em produção e estourou o
-- limite. Lia todos os Leads (seq scan) e todas as mensagens dos contatos pendentes. Índices parciais só do que a função usa.
create index if not exists hubspot_leads_dia_pendente_idx on painel.hubspot_leads (created_at)
  where respondeu_dia_marcado_at is null and etapas_entrada is not null and hubspot_contact_id is not null;
create index if not exists chat_messages_lead_resposta_idx on painel.chat_messages (lead_id, sent_at)
  where sender = 'lead' and not auto_reply;
