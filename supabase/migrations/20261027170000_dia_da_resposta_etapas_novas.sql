-- Funil novo (27/10/2026): etapas "DN R > Manhã" e "DN R > Tarde" entram no mapa do dia da resposta, cada uma no seu dia.
-- As "DN Realizado" continuam no mapa enquanto existirem (histórico guardado em etapas_entrada).
update painel.settings
   set value = value || '{
     "1470593931": "Respondeu D1", "1470593932": "Respondeu D1",
     "1470593933": "Respondeu D2", "1470593934": "Respondeu D2",
     "1470593935": "Respondeu D3", "1470593936": "Respondeu D3",
     "1470593937": "Respondeu D4", "1470593938": "Respondeu D4"
   }'::jsonb,
       updated_at = now()
 where key = 'hubspot_cadencia_etapas';
