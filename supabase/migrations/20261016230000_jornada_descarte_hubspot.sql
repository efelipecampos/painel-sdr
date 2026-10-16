-- Jornada (2026-10-16, decisões do Felipe): a regra pode descartar o Lead no HubSpot quando o lead clica no botão
-- (caso "Eu e mais 1" do template de corte). O worker move o Lead mais recente do contato no pipeline New para
-- Descartado, preenche [SDR] Motivo de Perda e a Observação de desqualificação e põe "D. Auto. Botões | " no começo
-- do nome. Descarta mesmo quando a mensagem não sai (o clique já é a resposta de qualificação); só a pausa impede.
-- Regra em teste não mexe no HubSpot. Lead em Descartado, DSQ, Garantir Agendamento ou Qualificado não é alterado.

alter table painel.journey_rules
  add column descartar boolean not null default false,
  add column descarte_motivo text,      -- valor de sdr__motivo_de_perda
  add column descarte_obs text;         -- hs_lead_disqualification_note

alter table painel.journey_rules add constraint journey_rules_descarte_chk check (
  not descartar or (coalesce(btrim(descarte_motivo), '') <> '' and coalesce(btrim(descarte_obs), '') <> '')
);

-- Resultado do descarte no HubSpot para aquele clique (null = a regra não descarta).
-- descartado | descartaria (teste) | já fora do funil | sem Lead no HubSpot | erro: <motivo>
alter table painel.journey_sends add column hubspot_descarte text;
