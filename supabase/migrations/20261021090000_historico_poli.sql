-- Histórico de conversas das SDRs, de 01/11/2025 em diante, puxado da API do Poli (decisão do Felipe, 2026-10-21).
-- Só para análises: nenhuma tela nem métrica do painel lê estas tabelas, e nada aqui muda public.raw_events,
-- public.messages ou as tabelas que o worker monta. Entra o contato que teve, em algum momento, um atendimento ou
-- uma mensagem de SDR. Sem telefone e sem nome do contato (LGPD): o contato é só o uuid do Poli.
-- Só o service_role lê e escreve (a carga roda no worker; as análises, por SQL).

-- Contatos do Poli criados desde 01/11/2025, um por linha, conferidos um a um pela carga.
create table painel.historico_contatos (
  poli_contact_uuid uuid primary key,
  criado_no_poli timestamptz not null,
  situacao text not null default 'pendente'
    check (situacao in ('pendente', 'sem_sdr', 'com_sdr', 'erro')),
  atendentes text[] not null default '{}',   -- nomes dos atendentes dos atendimentos do contato (para reconferir a regra)
  mensagens integer,                          -- mensagens gravadas (com_sdr)
  conferido_em timestamptz,
  erro text
);
create index historico_contatos_situacao_idx on painel.historico_contatos (situacao);

-- Mensagens dos contatos com SDR. author_* vem do Poli: quem escreveu (lead, atendente, bot).
-- atendente_* é o dono do atendimento em que a mensagem caiu.
create table painel.historico_mensagens (
  poli_message_uuid uuid primary key,
  poli_contact_uuid uuid not null references painel.historico_contatos (poli_contact_uuid) on delete cascade,
  poli_attendance_uuid uuid,
  enviada_em timestamptz not null,
  direcao text,                -- IN, OUT, SYSTEM
  tipo text,                   -- CHAT, TEMPLATE, IMAGE, AUDIO...
  evento text,
  autor_tipo text,
  autor_uuid uuid,
  autor_nome text,             -- só de atendente e bot; vazio quando o autor é o contato
  atendente_uuid uuid,
  atendente_nome text,
  template_nome text,
  texto text,
  botoes jsonb,
  ack text
);
create index historico_mensagens_contato_idx on painel.historico_mensagens (poli_contact_uuid, enviada_em);
create index historico_mensagens_atendente_idx on painel.historico_mensagens (atendente_uuid, enviada_em);

-- Andamento da carga (página da lista de contatos, contadores), para retomar de onde parou.
create table painel.historico_carga (
  chave text primary key,
  valor jsonb not null,
  atualizado_em timestamptz not null default now()
);

alter table painel.historico_contatos enable row level security;
alter table painel.historico_mensagens enable row level security;
alter table painel.historico_carga enable row level security;

grant all on painel.historico_contatos, painel.historico_mensagens, painel.historico_carga to service_role;
