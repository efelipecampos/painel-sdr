-- Status das reuniões vindo do HubSpot também para as anteriores a 28/10 (decisão do Felipe, 2026-10-30): o time
-- está atualizando no HubSpot as reuniões de 20 a 27/10, e o painel passa a receber. O worker continua olhando só
-- as reuniões dos últimos 21 dias.
update painel.settings set value = to_jsonb('2026-10-01T03:00:00Z'::text), updated_at = now()
 where key = 'reunioes_status_hubspot_desde';
