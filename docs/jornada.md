# Fase 11 — Jornada configurável (rascunho para aprovação)

Rascunho de 2026-10-15, com as respostas do Felipe do mesmo dia. Nada desta fase é implementado antes da aprovação dele e do que falta na seção 9.

## 1. Objetivo

O gestor configura no painel o que acontece quando o lead clica num botão de um template. Por exemplo: clicou "Eu e mais 1" → envia o template de encerramento; clicou "3 ou mais" fora do expediente → envia o template Manhã/Tarde. O painel executa o envio pela API do Poli e mostra o resultado de cada regra.

## 2. Decisões do Felipe (2026-10-15)

- **O painel configura e envia (opção B).** O worker lê o clique em `public.raw_events` e chama a API do Poli. As regras saem do n8n.
- **Quem configura:** só gestor e admin. O SDR não vê a tela.
- **Ação da primeira versão:** só "enviar template".
- **Futuro, fora desta fase:** configurar pelo painel a ordem de prioridade da lista de leads do SDR. Também ficam fora: mudar etapa no HubSpot, avisar SDR, fila.
- **Abertura e cadência D1 a D4 continuam no n8n.** O painel só responde aos cliques nos botões.
- **Se alguém da equipe já escreveu para o lead depois do clique, o painel não envia.**
- **Remetente:** o envio sai da conta principal da Poli, em nome do SDR dono do lead. O dono vem do HubSpot e é ligado ao atendente do Poli por `painel.sdrs.poli_attendant_uuid`. Lead sem dono, ou com dono sem atendente no Poli, não recebe o envio: fica como "pulado", com o motivo.
- **Documentação da API do Poli:** com o Felipe.

## 3. Como funciona

1. O lead clica num botão. O Poli manda o evento para a integração, que grava em `public.raw_events` como `messages.message.received`.
2. A cada 30 s, o worker procura cliques novos. Um clique é a primeira mensagem do lead depois de um template, com o texto igual a um botão desse template, ou com `context` apontando para a mensagem do template.
3. Para cada clique, o worker procura uma regra **ativa** que combine template + botão + horário (expediente, fora do expediente ou sempre).
4. Se houver regra e o lead ainda não tiver recebido o envio dela, o worker chama a API do Poli e envia o template da regra para o contato.
5. Cada tentativa vira uma linha em `painel.journey_sends`, com o resultado (enviado, falhou e o código do erro, pulado e o motivo).

O processamento é idempotente: a mesma regra nunca envia duas vezes para o mesmo lead, mesmo se o worker reprocessar o evento.

## 4. Regras de segurança do envio

- **Pausa geral** da jornada e pausa por regra, com efeito no ciclo seguinte do worker.
- **Modo teste:** regra nova nasce em teste. Enquanto está em teste, não envia ao lead: a cada clique real, manda a mesma mensagem (com os dados do lead) para o **telefone de teste**, um campo único na tela de Regras que o gestor preenche (decisão 15/10). A tela também tem o botão "Enviar esta mensagem para o telefone de teste". Sem telefone cadastrado, regra em teste não envia nada. Só vira "ativa" quando o gestor ativa.
- **Limite diário** de envios por regra é opcional. O padrão é **Sem limite** (decisão 15/10). Se o gestor escolher "Limitar" e a regra passar do número, o worker pausa a regra e gera um alerta.
- **Não enviar** se uma pessoa da equipe já escreveu para o lead depois do clique (decisão do Felipe).
- **Só templates cujas variáveis o painel consegue preencher**, para evitar o erro 100 da Meta. Exemplo: nome do contato.
- **Log sem conteúdo** (LGPD): só ids, regra, situação e código de erro. Nada de telefone nem texto da mensagem.
- Token da API do Poli **só no worker** (`.env`), nunca no navegador.

## 5. Telas (gestor e admin)

**Jornada · Regras**
- Lista das regras: template de origem, botão, horário, template enviado, situação (teste, ativa, pausada) e envios de hoje.
- Criar e editar regra: escolher o template de origem e o botão (dos templates conhecidos), o horário e o template a enviar.
- Botão de pausa geral no topo.
- Histórico: quem criou, mudou, ativou ou pausou cada regra, e quando.

**Jornada · Acompanhamento**
- Por regra, no período: cliques, envios feitos, falhas (com o motivo) e pulados.
- Depois do envio: quantos leads responderam e quantos agendaram.
- O funil da jornada (abertura → clique → "3 ou mais" ou "Eu e mais 1" → SDR respondeu → agendou), separado entre expediente e fora do expediente e por SDR. Esta parte é a "tela da jornada" e pode vir junto.

## 6. Banco (migrations nesta fase)

- `painel.journey_rules`: regra (template e botão de origem, horário, template de destino, situação, limite diário, quem criou e quando).
- `painel.journey_rule_changes`: histórico das mudanças.
- `painel.journey_test_contacts`: contatos da lista de teste.
- `painel.journey_sends`: cada tentativa de envio (regra, lead, evento do clique, situação, código de erro, id da mensagem no Poli). Índice único por (regra, lead).
- `painel.settings`: chave `journey_paused`.
- RLS: leitura e escrita só para gestor e admin. O worker usa service_role.

## 7. API do Poli (coleção Postman do Felipe, lida em 2026-10-15)

- **Autenticação:** `Authorization: Bearer <token>` (token de aplicação, criado em Applications → Tokens). Vai no `.env` do worker como `POLI_API_TOKEN`, junto com `POLI_API_URL` (o `{{host}}` da coleção). Nunca no navegador.
- **Enviar template ao lead:** `POST {host}/contacts/{contact_uuid}/messages` com `provider: "WHATSAPP"`, `account_channel_uuid` (Canal Principal, `9b8bae9e-2fe2-4f2a-82a2-abb931c7d7ce`), `type: "TEMPLATE"`, `template_uuid`, `version: "v3"` e `components.header/body.parameters` (variáveis).
- **Enviar ao telefone de teste:** `POST {host}/accounts/{account_uuid}/contacts/{telefone}/messages` (mesmo corpo). Conta `9b8af98e-0407-49a2-bce9-3620f29c513a`.
- **Listar templates:** `GET {host}/accounts/{account_uuid}/templates?include=key,version,status,message,components,interactive`. Alimenta a tela de regras (templates e botões).
- **Situação da mensagem:** webhook `ack` (CREATED, QUEUED_BY_PROVIDER, RECEIVED_BY_PROVIDER, RECEIVED_BY_CLIENT, READ_BY_CLIENT, ERROR). Hoje a integração não grava esse evento.
- **Clique:** o evento `received` traz `context.message.uuid` apontando para a mensagem do template, mas só em parte dos cliques (4 de 300 mensagens com `context` em 14/10). O painel identifica o clique pelo texto igual ao do botão do último template enviado ao contato, e usa o `context` quando ele vier.

**O que a API não faz: escolher o autor.** O envio sai em nome de quem é dono do token. As aberturas da automação de hoje já saem assim, sem nome de atendente (por isso o `[operator_name]` vazio e o risco de erro 100). "Em nome da SDR" é o primeiro nome da SDR dona do lead no texto, numa variável que o painel preenche.

**Nada muda no Poli além do envio** (decisão do Felipe, 2026-10-15): o painel não encaminha nem atribui a conversa. Quem clicou e recebeu o envio ganha prioridade **na lista do próprio painel** da SDR. Isso faz parte da prioridade da lista, que é uma fase futura.

**Fora do painel, antes de ligar:**
- token da aplicação e host da API no `.env`;
- desligar no n8n as regras que passarem para o painel, no dia em que forem ativadas.

## 8. Ordem de entrega

1. Motor no worker, com as regras gravadas direto no banco (sem tela) e só modo teste, enviando para o número de teste do Felipe.
2. Tela de regras com pausa, teste e histórico.
3. Tela de acompanhamento e funil.
4. Ativação regra a regra, desligando o equivalente no n8n.

## 9. Em aberto

1. ~~**A documentação da API do Poli.**~~ Recebida em 15/10 (seção 7). Host de produção: `https://foundation-api.poli.digital/v3`. "Em nome da SDR" = nome no texto; nada de atribuir conversa no Poli.
2. ~~**O destino do modo teste.**~~ Resolvido em 15/10: campo "Telefone de teste" na tela de Regras, preenchido pelo gestor. Deve ser um número diferente do canal remetente.
