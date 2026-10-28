-- Bug de 2026-10-28 (diagnóstico da sessão a4): ao arquivar, o evento foi movido para a agenda de arquivo, mas o
-- passo seguinte (título/cor) falhou com 403 rateLimitExceeded antes de gravar a agenda nova; o banco ficou
-- apontando para a agenda do closer. Conferido no Google em 28/10 (só leitura): os 4 eventos estão no arquivo e não
-- estão na agenda do banco. O código passa a gravar a agenda logo depois de mover e a procurar no arquivo.
update painel.meetings
   set google_calendar_id = (select s.value #>> '{}' from painel.settings s where s.key = 'google_archive_calendar_id')
 where id in ('cb42a24b-e42f-4cc1-827b-8905f1626728',  -- Moveis Rauane, cancelada
              '1f8d7551-68d3-43fd-b0c5-8243fc5dba9c',  -- Dr. Paulo Barra, no show
              'd2c99b1e-c42c-46f5-9b18-93dcfb20b279',  -- Caemv, cancelada
              'e3d24f40-ceee-4c1b-94b3-84f31bab82e7')  -- AMOR SAÚDE, cancelada
   and exists (select 1 from painel.settings s where s.key = 'google_archive_calendar_id');
