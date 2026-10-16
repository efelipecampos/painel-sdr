-- Jornada (2026-10-16, aprovado pelo Felipe): a trava "a mesma regra nunca envia duas vezes ao mesmo lead" passa a
-- valer por regra + template enviado. Motivo: uma regra editada para mandar outro template continuava bloqueada pelo
-- envio antigo (caso do contato de teste do Felipe: a regra mandou D2_proximos_tarde às 09:16, foi editada para
-- Eu-mais-1-descarte às 12:16 e o clique das 12:17 foi pulado como "já enviado").
-- Envios antigos ficam com o template vazio e não bloqueiam ninguém.

alter table painel.journey_sends add column dest_template_uuid text;

drop index painel.journey_sends_uma_vez_por_lead;
create unique index journey_sends_uma_vez_por_lead on painel.journey_sends (rule_id, poli_contact_uuid, dest_template_uuid)
  where mode = 'real' and status = 'enviado';
