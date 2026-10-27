-- Descarte do Lead no HubSpot por tag da Poli (decisão do Felipe, 2026-10-27).
-- O SDR aplica no contato da Poli uma tag "Descarte - <motivo>" (37 tags criadas pelo painel em 27/10, uma por motivo
-- de "[SDR] Motivo de Perda"). A integração grava em raw_events só o evento "tag_linked" dessas tags; o worker descarta o
-- Lead mais recente do contato no pipeline do SDR, com o motivo da tag e a observação "Descartado via integração com
-- Tag Poli. ...", sem prefixo no nome. Tirar a tag não desfaz. Lead já Descartado, DSQ, Garantir ou Qualificado: não mexe.

-- Tag da Poli (uuid) → valor de sdr__motivo_de_perda no HubSpot. Tag nova: incluir aqui.
insert into painel.settings (key, value) values ('poli_tags_descarte', '{
  "a315691d-683e-4d65-81b5-a7659be97042": "Valor fora do orçamento",
  "a315691d-bd3b-40ac-b228-b01d6eb49ae1": "Possui uma equipe com menos de 3 atendentes",
  "a315691e-19cb-4b1c-9589-6494878b432b": "Lead Autônomo",
  "a315691e-7110-49a5-aff3-9bb7817cb7c2": "Sem CNPJ",
  "a315691e-c1d4-473b-9267-0d815cb12946": "Já é cliente Poli",
  "a315691f-13ee-41f5-b025-c257590cb7ad": "Engano",
  "a315691f-63df-4439-8767-c5467ac2d138": "número de telefone incorreto",
  "a315691f-bc4d-49b2-b8cc-93e94a7b6cba": "Sem interesse no momento",
  "a3156920-0a6d-4faf-9629-4d1d65a4f4d9": "Não era o que buscava",
  "a3156920-5f32-4f9a-8fdd-f04aa4c435ac": "Buscando apenas disparador de mensagens",
  "a3156920-b283-4b27-97ab-6e5470e1592c": "Buscando apenas CRM",
  "a3156921-0640-491e-9024-600c667875f2": "Buscando apenas Chatbot",
  "a3156921-5c67-4e60-81a0-ea42abf7abc4": "Fechou com outra empresa por conta de valores",
  "a3156921-a7ba-4bc3-b6da-73c47972e3e3": "Lead fora das Políticas comerciais do WhatsApp",
  "a3156921-fd2f-43af-97e4-fbb50a4e13b9": "Duplicado",
  "a315693a-4f9f-4c75-869f-7ab5b87c0fc0": "Faltam funcionalidades (Quais?)",
  "a315693a-a75a-493f-9d7a-8ba89c0b1088": "Já está em negociação com um consultor",
  "a315693a-f996-4ae0-851f-a5640b814148": "Cadastro Incompleto (Sem Telefone e Sem E-mail)",
  "a315693b-4ab2-443c-bd9a-35c4ed3f6eaa": "Diretoria não dará continuidade no projeto",
  "a315693b-99bf-44dd-9125-07a28fcca82d": "Cliente não quis retornar pois está satisfeito com a solução que usa",
  "a315693b-ed18-4ef2-801c-a7e929502b5d": "Término de carteira",
  "a315693c-402d-4443-ab25-bb4ebd00cabf": "Falta de integrações nativas",
  "a315693c-95a3-4a42-9472-9c84943bd3ea": "Fechou com outra empresa por conta de funcionalidades",
  "a315693c-e637-4b8d-a248-3155a6aba277": "buscando apenas indicar a Poli / Parcerias",
  "a315693d-37c8-4ee8-b2a8-226ed19a37bf": "Falta de funcionalidades no CRM (Quais?)",
  "a315693d-87e5-4133-8d47-813e6c8107ec": "Cliente não quer responder a qualificação",
  "a315693d-d35d-439c-945e-cb77b6cf3307": "Teste de Marketing",
  "a315693e-2672-447d-a3ab-94b839bc9ba1": "Sem timing/prioridade",
  "a315693e-8589-41e1-8b82-3b51f0f7218f": "Não tem número de telefone",
  "a315693e-dd20-48cb-8e8c-30f5015114cd": "Precisa de fatura emitida no seu país",
  "a315693f-308c-44b3-9b77-ba42a77653f6": "Só quer uma parceria",
  "a315693f-84ba-417b-ae58-9bb86b3e5afe": "Preço do template",
  "a315693f-d05a-4dde-a14f-c175f1aa9a97": "Sem aplicativo não tem como agendar",
  "a3156940-32ac-4501-9874-74e9c4d9e8e3": "Buscando WhiteLabel",
  "a3156940-866d-49bc-8af2-55c758d31f58": "Buscando apendas IA (Inteligência artificial)",
  "a3156940-e0c3-4695-8fec-3629fc40d8c5": "Começou a responder, mas nunca terminou a qualificação",
  "a3156941-3821-4b8b-93df-253cbc886ade": "Não consegui envolver o decisor"
}'::jsonb)
on conflict (key) do update set value = excluded.value, updated_at = now();

-- Cursor em raw_events: começa no fim (nada de tag de descarte antes de hoje).
insert into painel.settings (key, value)
select 'tag_descarte_cursor', to_jsonb(coalesce(max(id), 0)) from public.raw_events
on conflict (key) do nothing;

-- Registro de cada tag de descarte processada (resultado do descarte no HubSpot).
create table painel.tag_descartes (
  raw_event_id bigint primary key,
  poli_contact_uuid text,
  tag_uuid text,
  tag_nome text,
  motivo text,
  hubspot_contact_id text,
  sdr_id uuid references painel.sdrs,
  aplicada_em timestamptz,
  resultado text not null,
  processado_em timestamptz not null default now()
);
alter table painel.tag_descartes enable row level security;
grant all on painel.tag_descartes to service_role;
