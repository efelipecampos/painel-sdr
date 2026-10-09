# COMECE AQUI — guia de condução do Painel SDR

Este documento é para o Claude Code conduzir o projeto inteiro com o Felipe, do estado atual até o painel no ar. Leia até o fim antes de agir. Depois leia `CLAUDE.md`, `docs/spec.md`, `docs/roteiro.md` e `docs/integracao-mudancas.md`.

Mantenha a seção **Estado atual** atualizada: marque o que foi concluído e registre decisões novas em **Decisões**, com a data. Faça commit dessa atualização junto com o trabalho da fase.

---

## 1. Como trabalhar com o Felipe

- Felipe é Head of Revenue da Poli Digital. Entende o negócio a fundo; não é desenvolvedor. Conhece o básico de Supabase, GitHub e VPS, e opera tudo pelo Orca.
- Comunicação direta e curta, em português. Sem rodeio e sem jargão sem explicação.
- Quando ele precisar fazer algo fora do Claude Code (painel do Supabase, HubSpot, DNS, VPS), diga exatamente onde clicar, um passo por vez, e o que ele deve ver no final. Nunca "configure o X": diga "abra X → clique em Y → copie Z".
- Uma fase por vez. No início de cada fase, diga em 2 ou 3 linhas o que vai ser feito e o que ele vai ter no final. No fim, diga o que ficou pronto, o que ele precisa conferir e qual é o próximo passo.
- Nunca peça para ele colar chave, senha ou token no chat. Segredo vai direto no `.env`, que ele edita no TextEdit (`open -e .env`). Você não lê nem imprime o `.env`.
- Pergunte antes de decidir qualquer regra de negócio que não esteja no `spec.md`. Nunca invente definição de métrica.

## 2. Pontos de parada obrigatórios

Pare e espere o "ok" do Felipe antes de:

1. Começar a escrever código de uma fase (mostre o plano primeiro).
2. Aplicar qualquer SQL no Supabase (mostre o SQL completo antes do `supabase db push`).
3. Fazer merge de um branch na `main`.
4. Qualquer coisa que toque produção: VPS, integração PoliChat-Hubspot, HubSpot.
5. Ligar o job de score com IA (mostre o custo estimado antes).
6. Instalar serviço, linguagem ou ferramenta que não esteja na stack do `CLAUDE.md`.

## 3. Checklist de revisão (use antes de cada ponto de parada)

Antes de pedir aprovação, confira você mesmo e diga ao Felipe o resultado de cada item que se aplica:

**SQL / migrations**
- [ ] `public.messages` idêntica a `/Users/felipecampos/Desktop/PoliChat-Hubspot/supabase/schema.sql`.
- [ ] `public.raw_events` idêntica à de `docs/integracao-mudancas.md`.
- [ ] Todas as tabelas com RLS ligado.
- [ ] Nenhum GRANT para `anon`.
- [ ] GRANT para `authenticated` só no que a tela usa (RPCs e tabelas de configuração que o admin edita).
- [ ] GRANT explícito para `service_role` em tudo que a integração e o worker usam, inclusive sequências.
- [ ] Nenhuma migration altera ou apaga coluna de `public.messages` ou `public.raw_events`.
- [ ] Schema `painel` incluído em Exposed schemas (Settings → API) só se a tela precisar via Data API.

**Código**
- [ ] `service_role` nunca aparece em código que roda no navegador.
- [ ] Nada de conteúdo de mensagem ou telefone completo em log.
- [ ] Testes passando (`npm test`), com os casos pedidos na fase.
- [ ] Nada fora do combinado: tabela, serviço ou dependência que não está no spec.

**Deploy**
- [ ] Nada usa as portas 80/443 da VPS (quem usa é o Coolify/Traefik).
- [ ] `docker-compose.yml` segue o padrão do `PoliChat-Hubspot` (rede `coolify`, labels do Traefik, sem `ports:`).
- [ ] DNS do subdomínio criado e resolvendo antes do deploy.

## 4. Estado atual

Atualize esta lista conforme avança.

**Pronto**
- [x] Protótipo das telas aprovado (`design/`): painel com cards por SDR, tabela de chats do SDR com status de reunião, configurações.
- [x] Projeto Supabase criado: `pabbgxaphooftdsdewmq` (São Paulo). "Automatically expose new tables" desligado, "automatic RLS" ligado. Integração com GitHub DESCONECTADA de propósito.
- [x] Repositório GitHub `efelipecampos/Painel-de-SDR` clonado em `~/orca/Painel-de-SDR` com os arquivos do kit.
- [x] Integração `PoliChat-Hubspot` lida e analisada (ver seção 5).

**Falta, na ordem**
- [x] 0.1 Apagar `.git/stale-index.lock.removeme` (sobra de uma trava do git; é seguro apagar).
- [x] 0.2 Criar `.env` a partir do `.env.example` e abrir no TextEdit para o Felipe preencher. Chaves: aba **Legacy API keys** do Supabase (`anon` e `service_role`) e a senha do banco.
- [x] 0.3 Commit inicial na `main` com `CLAUDE.md`, `docs/`, `design/`, `.gitignore`, `.env.example`. Confirmar que `.env` NÃO entrou. Push.
- [x] Fase 1 — Projeto e banco (roteiro). Aplicada no Supabase e mergeada em 2026-09-29.
- [x] Fase 2 — Evento cru na integração (no repositório PoliChat-Hubspot; ver seção 6). No ar desde 01/10/2026.
- [x] Esperar 1 a 2 dias de eventos reais em `public.raw_events`.
- [x] Fase 3 — Parser e worker (sem backfill: dados a partir de 01/10/2026). Worker roda manualmente (`npm run once -w @painel/worker`) até o deploy da Fase 5.
- [x] Fase 4 — Métricas no banco (Felipe confere os números com o Poli). Concluída em 05/10/2026, com sync de Leads do HubSpot (descarte, Descartados, DSQ) adiantado da Fase 6.
- [x] Fase 5 — Telas, login e deploy do painel. No ar em https://painel-sdr.camposai.com.br desde 06/10/2026.
- [x] Fase 6 — Reuniões (versão enxuta): agendamento pelo HubSpot (Garantir Agendamento / Qualificado) + marcação manual por admin/gestor. No ar desde 06/10/2026. Em aberto (sem trabalho previsto aqui; a Fase 10 resolve, porque o agendamento passa a nascer no painel): em que dia o agendamento conta (Garantir Agendamento × Qualificado), nota interna "agendado" e data da reunião.
- [x] Fase 7 — Score de qualidade. No ar em 07/10/2026 (deploy 23h57, main ac38aec): uma análise por dia às 05:00, carteira e qualidade nos cards, coluna "Qualidade" na tela do SDR, alerta "score" no Google Chat. Modelo e chave em `ANTHROPIC_MODEL` / `ANTHROPIC_API_KEY` (só no `.env`). 7c (critérios e contexto editáveis em Configurações, só admin) no ar em 08/10/2026. Salvar gera versão nova e os leads são reavaliados, até 300 por dia. Em 08/10/2026 a IA passou a ser a Celeris (`SCORE_IA=celeris`, main 7b4ccf4); rodadas de 2 em 2 horas das 08:00 às 18:00 (`SCORE_HORARIOS`) no ar em 08/10/2026 (main d2baae7).
- [ ] Fase 8 — Operação (conferência diária, alertas, backup, revisão de segurança). Feito: alertas no Google Chat, espaço "Gestão SDR" (fila parada 10 min, Poli sem eventos 30 min em horário comercial, worker com erro 5 min, HubSpot 30 min, painel fora do ar 5 min, score), no ar desde 07/10/2026; backup = backup diário do Supabase Pro (decisão de 07/10); limite de tentativas no login no ar em 08/10/2026. Falta: conferência diária com a API da Poli (inclui achar eventos que a Poli não mandou, como o caso João Obina), instruções de deploy de atualização no README e o resto da revisão de segurança (cabeçalhos HTTP, rate limit no webhook da integração).
- [ ] Fase 9 — SDR Modelo (ideia do Felipe, 2026-10-06): o gestor configura o SDR Ideal (faixas e pesos por comportamento: volume, 1ª resposta, tempo de resposta, taxa de resposta, descartes, reuniões validadas); a IA analisa periodicamente os melhores atendimentos (reunião validada / lead de alta qualidade) e sugere ajustes ao SDR Ideal com dados reais, que o gestor aprova ou não; cada SDR ganha uma aderência ao SDR Modelo com o detalhe de onde está dentro e fora. Depende das Fases 6 e 7.
- [ ] Fase 10 — Agendamento e carrossel de reuniões (pedido do Felipe, 2026-10-06): SDRs entram no painel (desde 08/10 veem tudo de todos) e agendam reuniões na Google Agenda dos closers; o sistema distribui entre os closers por pesos definidos pelos gestores. Especificação completa em `docs/agendamento.md`; telas em `design/Agendar.dc.html`, `design/AgendarSucesso.dc.html`, `design/Reunioes.dc.html`, `design/Carrossel.dc.html` e `design/Usuarios.dc.html`. Substitui a Poli Agenda (feita no Lovable), construída do zero. Não depende das Fases 7 e 9. Antes de liberar para os SDRs: backup e alerta da Fase 8 e Supabase no plano Pro.
  - [x] 10a — Acesso do SDR (papel `sdr`, escopo por SDR no banco, tela "Meus chats"). No ar desde 07/10/2026; testado pelo Felipe com o login da Isadora.
  - [x] 10b — Carrossel sem Google, tela Usuários e remover closer. No ar e no `main` desde 07/10/2026.
  - [x] 10c — Google Agenda: papel closer, conexão da agenda pela tela do closer, livre/ocupado, criar/alterar/arquivar/restaurar evento, conferência no worker a cada 10 min, tela Teste da agenda (admin). No ar e no `main` desde 07/10/2026. Testado pelo Felipe com o Calil (agenda conectada; ocupado bateu com a agenda real; Meet, convite, arquivo vermelho e volta conferidos). O app web passou a receber a service_role (só no servidor, para a conexão do Google). Logins de closer: Calil e Alessandra.
  - [x] 10d — Agendar (10d.1 agendar pelo painel; 10d.2 Reuniões, status com arquivo, mudar horário/reagendar). No ar e no `main` desde 07/10/2026, testadas pelo Felipe.
  - [x] 10e — HubSpot e trocas: Reunião no HubSpot (criação, atualização, status às 17:55), pedido de troca de closer com fila e aviso no Gestão SDR, troca direta, Passar para CH/Poli, relatório. No ar e no `main` desde 07/10/2026, testadas pelo Felipe (reuniões de teste apagadas do painel, do Google e do HubSpot).
  - [x] Virada da Poli Agenda: concluída no fim do dia 08/10/2026; desde 09/10 toda a operação de SDR agenda pelo painel.
  - [x] Ajustes da virada (08/10/2026): acesso global do SDR, SDR responsável = dono da carteira, botão Finalizar, transferência entre SDRs leva a espera para quem recebeu, login leva cada um à própria tela.
  - [ ] Falta na Fase 10: Aline Paiva conectar a agenda quando voltar das férias (terça, 13/10); Lucas Cintra pediu demissão: desativar na tela Usuários (os outros 7 conectados em 09/10, inclusive as contas @chatshub.com.br), conferir os 7 carrosséis montados, "Adicionar usuário" e trocar papel pela tela Usuários.

## 5. O que já se sabe sobre a integração PoliChat-Hubspot

- Pasta: `/Users/felipecampos/Desktop/PoliChat-Hubspot`. Node + TypeScript, Express, zod, vitest. Em produção na VPS da Hostinger (IP `76.13.112.74`), em `/root/poli-hubspot`, domínio `poli-hubspot.camposai.com.br`.
- A VPS roda **Coolify**; o Traefik dele faz domínio e HTTPS. Deploy da integração: rsync para a VPS + `docker compose up -d --build`.
- Recebe o webhook de mensagens da Poli, valida a assinatura, registra no HubSpot como Communication, alerta no Google Chat quando o contato não existe.
- Já tem código para espelhar mensagens em `public.messages` no Supabase, mas NUNCA gravou: `SUPABASE_URL` está vazio.
- Quando o Supabase for configurado nela, liga sozinha a **nota diária por contato no HubSpot** (`DAILY_NOTES_ENABLED` é `true` por padrão). Decisão atual: `DAILY_NOTES_ENABLED=false` até o Felipe decidir.
- O papel SDR/Closer vem das listas de e-mail `POLI_SDR_EMAILS` e `POLI_CLOSER_EMAILS` do `.env` dela.
- Descarta hoje o que o painel precisa: eventos `SYSTEM` (transferência, abertura, encerramento), e não guarda `attendance.uuid`, `attendance.status` nem `author.type`. Por isso a Fase 2 existe.
- Tem script de backfill `npm run backfill:supabase` que preenche `public.messages` com o histórico a partir do HubSpot.
- Código reaproveitável no painel: `src/poli/types.ts` e `src/poli/parser.ts` (formato do evento), `src/hubspot/phone.ts` (telefone), matching de contato já feito (use `public.messages.hubspot_contact_id`).

## 6. Como conduzir a Fase 2 (integração)

A Fase 2 mexe em produção e em outro repositório. Não edite a integração a partir desta pasta.

1. Confirme que a Fase 1 está aplicada: `public.messages` e `public.raw_events` existem no Supabase.
2. Diga ao Felipe para abrir no Orca uma sessão do Claude no projeto **PoliChat-Hubspot** e colar o prompt de `docs/integracao-mudancas.md`, com o conteúdo desse arquivo junto.
3. Avise o Felipe dos dois pontos críticos antes do deploy: `DAILY_NOTES_ENABLED=false` no `.env` da VPS, e usar a chave `service_role` da aba Legacy.
4. Depois do deploy, peça para ele rodar no SQL Editor do Supabase:
   `select event_type, count(*) from public.raw_events group by 1;`
   e conferir no HubSpot que as mensagens continuam chegando.
5. Marque a Fase 2 como pronta e anote a data de início dos eventos em **Decisões**.

## 7. Pendências para decidir com o Felipe (pergunte na fase indicada)

| Pendência | Quando perguntar |
|---|---|
| Ligar ou não a nota diária no HubSpot (`DAILY_NOTES_ENABLED`); hoje `false` | Quando o Felipe quiser |
| Em que dia o agendamento conta (entrada em Garantir Agendamento × Qualificado) — substituído pelo agendamento dentro do painel | Fase 10 |
| Formulário de cadastro: separar a faixa "2 a 4 colaboradores" (o corte real é 3 atendentes) | Quando o Felipe quiser |
| Retenção de conteúdo de mensagens (LGPD) | Fase 8 |

## 8. Decisões

Registre aqui toda decisão nova, com data.

- 2026-09-29 — Métricas da V1 conforme `spec.md` seção 2: lead abordado conta uma vez; tempo de resposta começa na primeira mensagem do bloco do lead; "aguardando" só conta chats abertos; dono do lead é o SDR responsável no momento de cada mensagem.
- 2026-09-29 — Reuniões: 5 status (Agendada, Validada, No show, Invalidada, Cancelada). Conversão para análise = Validada. HubSpot preenche Agendada, No show e Cancelada; Validada e Invalidada são manuais e não são sobrescritas pelo sync. Todo histórico de mudança é guardado.
- 2026-09-29 — Sem metas na V1 (sem cores de meta). Único destaque: laranja `#f0a93b` para leads parados acima do limite (padrão 30 min).
- 2026-09-29 — Filtro de período com data e hora + botão "Só horário comercial"; horário comercial configurável.
- 2026-09-29 — Score de qualidade recalculado de hora em hora, só leads com mensagem nova.
- 2026-09-29 — Banco único `pabbgxaphooftdsdewmq` para integração e painel. Migrations de todo o banco ficam neste repositório. Integração escreve em `public.messages` e `public.raw_events`; painel só lê essas duas e mantém o resto no schema `painel`.
- 2026-09-29 — Migrations aplicadas só pelo Supabase CLI (`supabase db push`), depois da aprovação do Felipe. Integração GitHub ↔ Supabase desligada.
- 2026-09-29 — Deploy no padrão Coolify/Traefik da VPS, igual à integração. Sem Caddy ou Nginx.
- 2026-09-29 — Testes das funções SQL rodam no PGlite (Postgres em memória, dependência só de desenvolvimento), aplicando as migrations reais. Sem Docker e sem tocar o banco de produção.
- 2026-09-29 — Horário comercial inicial: segunda a sexta, 08:00–18:00 (protótipo). Configurações iniciais: fuso `America/Sao_Paulo`, parado a partir de 30 min, feriados não contam.
- 2026-09-29 — Migrations aplicadas com `npm run db:push` (conexão direta pelo pooler `aws-0-sa-east-1`, modo sessão, com a senha do `.env`). Sem `supabase link` e sem token de acesso: o link exigiria permissão de ler as chaves de API. Sempre rodar `npm run db:push -- --dry-run` antes e mostrar ao Felipe.
- 2026-09-29 — Fase 1 aplicada no Supabase: 4 migrations, 16 tabelas (2 em `public`, 14 em `painel`), com os valores iniciais gravados.
- 2026-09-30 — `raw_events` guarda só o que é da equipe de pré-vendas: eventos de chats cujo dono (`attendance.attendant.email`) é SDR ou closer, mensagens do app token e o evento SYSTEM que tira o chat da equipe. Mensagens do lead entram enquanto o dono for da equipe. Resposta do lead em chat sem dono da equipe não é gravada (aceito). Regra completa em `docs/integracao-mudancas.md`.
- 2026-10-01 — Fase 2 no ar: primeiro evento em `public.raw_events` em 01/10/2026 às 07:08 (Brasília).
- 2026-10-04 — Mapeamento dos eventos da Poli (Fase 3): lead = `author.type CONTACT`; pessoa da equipe = autor `USER` com `uuid`; app token/bot = autor `USER` sem `uuid` (com template = template do app token); SYSTEM `ATTENDANCE_REDIRECTED` = transferência (abre atendimento novo), `ATTENDANCE_CLOSED` = encerramento; `NOTE`, `SUMMARY`, `CONTACT_UPDATED` ficam guardados mas não entram nas métricas.
- 2026-10-04 — Resposta de outra pessoa da equipe no chat de um SDR conta como resposta, creditada ao SDR dono do chat. Templates do app token contam como template/lead abordado do SDR dono do chat.
- 2026-10-04 — Tempo de resposta e tempo de primeira resposta usam **mediana**, não média. Resposta = mensagem escrita por pessoa da equipe ou template enviado manualmente; template do app token e bot não contam. A resposta pode vir em qualquer atendimento do mesmo lead. Primeira resposta = primeira mensagem do lead em cada atendimento.
- 2026-10-04 — Chat aberto = sem encerramento da Poli e sem atividade (lead ou equipe) em outro atendimento do mesmo lead depois da última atividade dele.
- 2026-10-04 — Papéis: SDRs = 8 e-mails (inclui Lia); closers = 11; gestores = Iago, Felipe, Hugo, Marcos. Listas em `POLI_SDR_EMAILS`, `POLI_CLOSER_EMAILS`, `POLI_MANAGER_EMAILS`. Tifany e Poliana são de outros departamentos. Cards mostram só SDRs.
- 2026-10-05 — Quem iniciou é por **lead** (`painel.leads.initiated_by`): primeira mensagem, sem eventos de sistema, do primeiro atendimento do lead. Responde "o lead veio por iniciativa dele ou fomos atrás?". Aparece só como coluna "Origem" na tabela de chats do SDR. (`painel.chats.initiated_by`, por atendimento, continua calculado mas não é usado na tela.)
- 2026-10-05 — Nova métrica no card: **Leads que responderam** = leads distintos que mandaram pelo menos 1 mensagem em chat do SDR no período.
- 2026-10-05 — **Carteira** = leads em aberto no funil do SDR no HubSpot (proteção de 30 dias já existe no HubSpot). Entra na Fase 6, junto com a qualidade da carteira. Até lá o card mostra vazio.
- 2026-10-05 — Tabela do SDR mostra os chats em que ele é o dono e que tiveram mensagem no período. Contagens e tempos de cada linha são do chat inteiro.
- 2026-10-05 — Correção: as medianas de 1ª resposta e de resposta entram no período pelo momento em que o **lead escreveu**, não pelo da resposta. Motivo: na segunda-feira, respostas a leads do fim de semana e da semana anterior inflavam a mediana do dia (ex.: 37h para quem atendeu os leads do dia em 14min).
- 2026-10-05 — Horário comercial = segunda a sexta, **08:20–17:45** (configurável). Com "Só horário comercial" ligado (padrão da tela), as medianas usam só os leads que escreveram dentro do expediente, com o **tempo real** de espera (lead que escreveu 17:40 e foi respondido 08:30 esperou 14h50). Desligado: todos os leads, tempo real. Motivo: medir se quem escreveu no horário de trabalho foi atendido com o celular na mão.
- 2026-10-05 — Respostas automáticas do lead (WhatsApp Business respondendo segundos depois do template) contam como mensagem normal do lead.
- 2026-10-05 — O número ao lado de cada mediana de tempo é a quantidade de **leads** distintos que entraram na conta, não de respostas.
- 2026-10-05 — "Só horário comercial" sai da tela principal e vira opção das Configurações (`painel.settings.metrics_business_only`, padrão marcada). Marcada: medianas só com leads que escreveram no expediente. Desmarcada: qualquer mensagem do lead. Tempo sempre real. A tela mostra um único número por métrica.
- 2026-10-05 — Descarte vem do **objeto Lead do HubSpot**, pela etapa do funil. No "[New] Pipeline SDR" (id 841793591), as etapas **Descartado** (1250901141), **DSQ - BR** (1250901142) e **Qualificado** (1358962969) tiram o lead de "Aguardando" e "Parados" (vale o Lead mais recente do contato). "Garantir Agendamento" e as etapas de cadência continuam com o SDR. Medianas não mudam. A lista de etapas fica numa configuração. Sync do HubSpot adiantado da Fase 6; o token do app privado precisa de leitura de Leads.
- 2026-10-05 — Descarte também por **nota interna da Poli**: o SDR escreve "Finalizado", "DSQ" ou "Descartado" (ou só 0, 1, 2) na nota. O lead sai de "Aguardando" e "Parados" e só volta quando existir no HubSpot um Lead do contato criado depois da nota e fora das etapas de descarte. O worker guarda só a marcação (`chat_messages.note_tag`), nunca o texto da nota. Limitação aceita: uma nota como "não foi descartado" também é lida como descarte.
- 2026-10-05 — Novas métricas do HubSpot: **Descartados** = Leads que entraram na etapa "Descartado" no período (lead abordado que o SDR descartou), no card do SDR pelo **dono do Lead no HubSpot**, e no Time. **DSQ** = Leads que entraram em "DSQ - BR" no período (cadastro não qualificado para abordagem), métrica separada, **só na linha do Time**. 
- 2026-10-05 — Contagem de Descartados e DSQ: **nota interna primeiro, HubSpot se não houver nota**. Com nota no período, conta para o SDR dono do chat no momento da nota; sem nota, vale a entrada na etapa do HubSpot (dono do Lead). O mesmo lead conta uma vez. **Finalizado** = suporte/caiu por engano, não é lead: sai só de Aguardando/Parados (continua nos tempos de resposta e em Leads que responderam) e não conta como Descartado nem DSQ. Conferência nota × HubSpot: não precisa.
- 2026-10-05 — **1ª resposta por ciclo do lead com cada SDR** (substitui "por atendimento"): conta o primeiro bloco do lead com aquele SDR; o ciclo recomeça quando o lead volta depois de nota interna (Descartado/DSQ/Finalizado) ou de entrar em Descartado/DSQ - BR no HubSpot. Transferência conta como 1ª resposta de quem recebeu. Atendimento novo aberto pela Poli no meio da conversa (ex.: template de cadência) não reinicia.
- 2026-10-06 — Subdomínio do painel: `painel-sdr.camposai.com.br` (registro A para 76.13.112.74, criado pelo Felipe na Hostinger).
- 2026-10-06 — Métricas da automação de disparo (app token / n8n), **só na linha do Time**: **Cadastro → disparo** = mediana do tempo entre a criação do Lead no [New] Pipeline SDR e o 1º template do app token para o contato (até 24 h); **Cadastros sem disparo** = Leads criados no período, fora de DSQ, sem template do app token em até 30 min. Em 05/10: mediana 4,1 min; 3 cadastros sem disparo fora de DSQ.
- 2026-10-06 — Login por **e-mail e senha** (Supabase Auth), sem cadastro aberto: o Felipe cria o usuário no Supabase (Authentication → Users → Add user) e o acesso é liberado com `npm run usuarios -w @painel/worker -- email:papel:Nome`. Usuários da V1: Felipe (admin), Iago Leal e Timóteo Luis (gestores).
- 2026-10-06 — Feriados: começam com os nacionais de out/2026 a dez/2027 (sem pontos facultativos); o admin edita na tela de Configurações.
- 2026-10-06 — Tela: "Só horário comercial" não fica na tela principal (é configuração). Carteira, qualidade e reuniões ficam escondidas até as Fases 6/7. Linha do Time mostra também DSQ, cadastro → disparo e cadastros sem disparo.
- 2026-10-06 — **A Lia é um robô** (mensagens automáticas com usuário próprio na Poli), assim como a Poliana. Lista `POLI_BOT_EMAILS`; `painel.sdrs.is_bot`. Mensagens de robô viram automação: não encerram a espera do lead, não contam como resposta e o robô sai dos cards. Os chats da Lia continuam sendo gravados pela integração (estão lá as primeiras mensagens do lead antes de ir para um SDR). Substitui a decisão de 2026-10-04/05 que colocava a Lia como SDR. A Lia continua em `POLI_SDR_EMAILS` **da integração** (registra no HubSpot e grava em `raw_events`): ela faz a qualificação da maioria dos leads DSQ.
- 2026-10-06 — Tabela da tela do SDR com **uma linha por lead** (não por atendimento da Poli): situação, contagens e tempos juntam os atendimentos do lead com o SDR. "Lead não respondeu" só quando o lead nunca escreveu.
- 2026-10-06 — Deploy feito: `https://painel-sdr.camposai.com.br` no ar (containers `painel-sdr-web` e `painel-sdr-worker` em `/root/painel-sdr`). Passo a passo de atualização em `docs/deploy.md`. O worker local foi desligado: só a VPS processa.
- 2026-10-07 — Status de reunião: **Agendada** (reunião combinada com o lead); **Validada** = realizada e o closer validou que é boa oportunidade; **Invalidada** = realizada, mas o closer achou red flag que fere o SLA; **No show** = lead não apareceu; **Cancelada** = lead cancelou antes. Quem muda à mão: admin e gestor.
- 2026-10-07 — Fase 6 enxuta: só identificar na lista quem agendou. **Agendada** vem do HubSpot (Lead mais recente do contato passou por "Garantir Agendamento" ou "Qualificado"); admin/gestor podem marcar qualquer status à mão na tabela, inclusive "Agendada"; o HubSpot nunca sobrescreve a marcação manual. Sem data da reunião. Objeto Reunião do HubSpot não é usado (processo mal implementado). Nota interna "agendado" fica para depois. Card e Time mostram **Agendados** (leads que agendaram no período, pelo dono do Lead) e a % sobre os abordados.
- 2026-10-06 — **Incidente:** o build do deploy da Fase 6 (14:41) esgotou a memória da VPS e travou tudo, inclusive a integração, por ~25 min (eventos da Poli perdidos, parte reenviada); VPS reiniciada pelo Felipe no hPanel. Medidas: swap de 4 GB criado, deploy só fora do horário comercial, build com limite de memória e uma imagem por vez (`docs/deploy.md`). Imagens passam a ser montadas no Mac e enviadas prontas (`npm run deploy`), aprovado pelo Felipe; o Mac só é usado no momento do deploy.
- 2026-10-06 — Sync do HubSpot continua a cada 15 min (mudança no HubSpot pode levar até 15 min para aparecer no painel). Transferência SDR → closer não é usada como sinal de agendamento: o SDR move o Lead no HubSpot.
- 2026-10-06 — Leads perdidos no incidente: janela 14:41–15:05 sem eventos (~100–250 eventos; 20 reenviados pela Poli). Não recuperável sem a API da Poli; métricas de tempo dessa meia hora podem estar distorcidas.
- 2026-10-07 — Caso do Samuel (6 agendamentos para ele, 4 no painel): diferença vem de 2 Leads que entraram em Garantir Agendamento em 05/10 e em Qualificado em 06/10; o painel conta na 1ª entrada. Definição do dia do agendamento fica para a Fase 10, que traz o agendamento para dentro do painel (o clique do SDR passa a ser o agendamento).
- 2026-10-07 — Análise de lead ruim (HubSpot, últimos 30 dias): 60% dos descartes são "Término de carteira" (não respondeu a cadência); 24% são equipe pequena ("menos de 3 atendentes" + "autônomo"); autônomo quase nunca qualifica (1% dos qualificados); 5+ funcionários = metade dos qualificados; a faixa "2 a 4" do formulário é ambígua. Base para os critérios da Fase 7.
- 2026-10-07 — Fase 10: resumo conferido pelo Felipe. Novas decisões registradas na seção 2 do `docs/agendamento.md` (carrossel sugerido por `sdr_2_0__quantidade_de_usuarios_a_utilizar_a_plataforma`, aviso de troca no espaço "Gestão SDR", disponibilidade validada no piloto, padrões da 10b aprovados). Plano da 10a aprovado, com dois acréscimos: testar que o SDR não altera o próprio perfil nem cria outro; revisar todas as rotas e ações de servidor do app web quanto a papel e escopo. Os logins dos SDRs só são criados depois do backup/alerta da Fase 8 e do Supabase Pro.
- 2026-10-07 — **Regra do DSQ (Marketing):** o lead que preenche o formulário do site e não atende o critério de qualidade do Marketing vai para DSQ, e não para o SDR. A **Lia** (robô) prospecta dentro dos DSQ, tentando achar empresas com mais de 3 usuários; o script dela está em teste. A Poli não vende para empresas com menos de 3 usuários.
- 2026-10-07 — Definição de lead ruim (análise de 763 leads com conversa e desfecho desde 01/10 + motivos de descarte de 30 dias): não conversa (60% dos descartes; mediana de 1–2 mensagens curtas, contra 7 dos qualificados); menos de 3 usuários / autônomo / "atendo sozinho"; pede para encerrar ou diz que não pediu contato; resposta automática do WhatsApp Business; procura disparo em massa, catálogo ou divulgação. Lead bom fala de equipe e estrutura (setores, diretoria, fluxo, CNPJ), descreve dor de atendimento, engaja (várias mensagens, áudio) e pede reunião (32% dos qualificados). Base para os critérios da Fase 7.
- 2026-10-07 — Tabela do SDR passa a listar também os leads aguardando agora, mesmo sem mensagem no período (antes o card mostrava 3 aguardando e a lista não mostrava nenhum).
- 2026-10-07 — 10a no ar. Login de teste = conta real da Isadora (`isadora.rocha@poli.digital`, papel sdr), escolha do Felipe. Os demais SDRs só ganham login depois do backup/alerta da Fase 8 e do Supabase Pro.
- 2026-10-07 — 10b aplicada (migration `20261008130000_carrossel`). Livro-caixa por saldo; lead preso ao closer por 30 dias avisa em vez de trocar; Reagendar/Editar tenta o mesmo closer e, se ocupado, o carrossel escolhe outro às cegas; troca de closer pelo gestor e troca de marca refazem o livro-caixa sem apagar histórico. O worker cadastra os closers da lista do `.env` que ainda não apareceram em chat.
- 2026-10-07 — Tela Usuários (migration `20261008140000_usuarios`): só o admin e quem tem `profiles.can_manage_users` (Timóteo) desativam/reativam. Desativar tira o acesso e tira das listas e carrosséis sem apagar nada. A soma do time conta todos os SDRs, inclusive desativados; a lista de SDRs mostra o desativado só nos períodos em que ele teve mensagem. Closer pode ser removido de um carrossel (o livro-caixa fica). Felipe é o admin do Google Workspace (para a 10c).
- 2026-10-07 — Google Agenda: caminho B confirmado (cada closer conecta a própria agenda), mesmo com o caminho A disponível. Tela Usuários lista só a equipe (SDR, closer, gestor, admin).
- 2026-10-07 — Divisão de trabalho entre duas sessões do Claude: esta segue na Fase 10 e é a única que edita este arquivo; a outra faz a Fase 8 (backup e alerta) num worktree e branch próprios, combina antes qualquer migration nova e avisa antes de mexer em produção.
- 2026-10-07 — Passagem de bastão: link do painel na descrição do evento (só abre com login).
- 2026-10-07 — Closers piloto da 10c: Calil e Alessandra.
- 2026-10-07 — Backup: só o do Supabase no plano Pro (diário, 7 dias), sem cópia extra fora do Supabase (decisão do Felipe).
- 2026-10-07 — Supabase já no plano Pro (backup diário). Virada da Poli Agenda: sem piloto de 1 ou 2 SDRs; entram os 7 SDRs de uma vez (decisão do Felipe, para acelerar).
- 2026-10-07 — Logins ligados: 7 SDRs e 9 closers (Alessandra, Aline, Calil, Jerferson, Larissa Ramos, Larissa Fernandes, Lucas, Mara, Maria Vitoria). Erika Lustosa e Ingrid Ribeiro saíram da empresa: desativadas no painel (dados mantidos).
- 2026-10-07 — Início do uso pelos SDRs: 08/10/2026 (Felipe). Erika e Ingrid ficam na lista de closers do `.env` (desativadas só no painel).
- 2026-10-07 — Telas da Fase 10 refeitas no layout de `design/` (Agendar, Reuniões, Usuários, Carrosséis), mantendo as decisões posteriores ao desenho (título padrão com campo Empresa, Lead não muda de etapa, sem link do Meet na tela, closer com login). Fora do desenho por ora: "Adicionar usuário" pela tela (precisa decidir como definir a senha) e troca de papel na lista (vem das listas do `.env`).
- 2026-10-07 — Divisão de trabalho atualizada: a Fase 7 (score de qualidade) passa para a outra sessão do Claude, num branch próprio a partir do main (afa2f11); esta sessão segue na Fase 10 (virada e ajustes) e continua sendo a única que edita este arquivo. Regras: combinar o nome de toda migration nova (a última é `20261008190000_trocas.sql`); avisar antes de recriar `sdr_metrics` ou `team_metrics`; deploy só a partir de branch atualizado com o main, um por vez; o Felipe repassa as mensagens entre as sessões (as mensagens diretas não chegam).
- 2026-10-07 — Contra reunião duplicada no HubSpot (principal problema hoje): uma reunião por lead (Reagendar em vez de agendar de novo; prazo "este mês", trocável para 30 dias em Configurações), aviso de Reuniões do contato no HubSpot fora do painel, conferência dos últimos 5 dias às 17:55 com correção, recriação e aviso de possível duplicada, alerta de falha em 15 min. No ar em 07/10/2026. Na virada: desligar a extensão do HubSpot e a Poli Agenda.
- 2026-10-07 — Fase 7 (decisões do Felipe): critérios e pesos Engajamento 3, Porte 3, Dor de atendimento 2, Intenção de avançar 2, Encaixe no produto 2; contexto da Poli inclui "funciona no computador"; só avalia conversa com pelo menos 2 mensagens escritas pelo lead; critério sem informação fica fora da média; só conversas com o SDR responsável; quem já é cliente fica sem nota; carteira sem Qualificado, Descartado e DSQ; uma análise por dia.
- 2026-10-07 — **Lentidão do painel:** a VPS fica em Boston (EUA) e o Supabase em São Paulo; cada ida ao banco custa ~200 ms. Melhorias sem custo no ar: login conferido uma vez por clique, dados em paralelo, tela de carregando, perfil sem ida extra ao servidor de login, telas já vistas guardadas por 30 s no navegador.
- 2026-10-07 — **Migração da VPS para São Paulo adiada** (sem verba agora; a Hostinger não ofereceu São Paulo na compra). Quando voltar: KVM 4 em São Paulo; migrar só painel SDR, poli-hubspot e api4com-hubspot (Chatwoots, Langfuse, n8n, agents e o postgres `swws40…` não estão em uso e o Felipe recomeça do zero). O disparo do app token é do n8n da própria Poli, não do n8n da VPS. Cópia dos bancos dos serviços não migrados em `~/Backups/vps-boston-20261007` no Mac do Felipe.
- 2026-10-05 — Sem histórico anterior e sem API da Poli por enquanto: o painel começa em 01/10/2026 07:08 (primeiro evento em `raw_events`). Chats que já existiam antes disso podem ter "quem iniciou" e a primeira resposta imprecisos. A ideia de backfill desde 25/09 foi abandonada.
- 2026-10-05 — Felipe conferiu 3 chats reais no Poli (linha do tempo e tempos de resposta): tudo certo.
- 2026-10-05 — Lia passa a ser SDR também na integração (`POLI_SDR_EMAILS` do `.env` da VPS). Efeito colateral aceito: as mensagens dela passam a ser registradas no HubSpot, como as dos outros SDRs.
- 2026-10-06 — Fase 10 (agendamento): agenda dos closers = Google Agenda; carrossel no modo "horário primeiro" (SDR escolhe o horário, o sistema dá a reunião ao closer livre de maior saldo); pesos por closer definidos por admin/gestor; distribuição por livro-caixa de créditos e débitos (`docs/agendamento.md`, seção 5); SDR entra com papel próprio e vê só os próprios chats, números e o agendamento; duas entradas para agendar (botão no topo e botão na linha do lead).
- 2026-10-07 — Fase 10 detalhada com o Felipe; **a fonte da verdade é `docs/agendamento.md`** (seção 2 lista as decisões). Resumo: construir do zero, sem reaproveitar a Poli Agenda; 7 carrosséis (4 Poli, 3 ChatsHub); closer às cegas (o SDR só vê o closer depois de confirmar, mas vê quantos closers há por horário); lead fica preso ao closer; troca de closer só por pedido do SDR com aprovação do gestor de SDR (Iago) ou de qualquer gestor/admin, com aviso no espaço "Gestão SDR" do Google Chat; ajuste livre de início e duração com reconferência da agenda; dados do lead vêm do HubSpot e o carrossel é sugerido pela propriedade de quantidade de usuários; telas novas de Reuniões, Carrosséis e Usuários. Onde este registro e o `agendamento.md` divergirem, vale o `agendamento.md`.
- 2026-10-08 — Acesso global do SDR (revoga a regra de 2026-10-07 de "SDR vê só o dele"): o SDR vê tudo de todos (painel do time, tela de qualquer SDR, todas as reuniões, notas e carteira), agenda lead de qualquer carteira e marca qualquer status (agendada, validada, no-show, invalidada, cancelada), inclusive em reunião feita fora do painel, e reagenda qualquer reunião. Motivo: gestor agendando, férias e falta (outro SDR cobre a agenda). A reunião fica com o **dono da carteira** (campo "SDR responsável" vem preenchido com o dono do contato no HubSpot, se for SDR, ou com o SDR do atendimento mais recente; pode ser trocado). Ao entrar, o SDR cai na própria lista. Continua só de gestor/admin: Usuários, Carrosséis, Configurações, Relatório, decidir pedido de troca e trocar closer. Closer segue vendo só as reuniões dele. Migration `20261008210000_acesso_global_sdr.sql`. No ar em 08/10/2026 (main 57a51f1), junto com: login leva cada um à própria tela, seletor de SDR do gestor corrigido, voltar da tela de agendar leva à lista do SDR.
- 2026-10-08 — A Poli às vezes não manda eventos de um contato (caso João Obina, do Samuel: só chegaram 4 eventos de 01/10; a conversa seguinte, a finalização e a nota "0" nunca chegaram). Conferência: só 2 leads em "Aguardando" há mais de 2 dias (João Obina e Neto Ribamar #23910, do Matheus). Saída: botão **Finalizar** na lista do SDR (admin, gestor e SDR), mesmo efeito da nota "0", com Desfazer; motivo "Finalizado (painel)". Não reinicia o ciclo da 1ª resposta (isso continua só pela nota). Migration `20261008220000_finalizar_lead.sql`. No ar em 08/10/2026 (main 94162b6).
- 2026-10-08 — Timóteo (dono da Poli) consulta o banco pelo Claude dele com o conector MCP oficial do Supabase, em modo só leitura e restrito ao projeto `pabbgxaphooftdsdewmq` (decisão do Felipe: caminho 1, banco inteiro, em vez de um conector próprio do painel com dados filtrados). Ele vê tudo, inclusive telefones completos e eventos crus; o modo só leitura impede alterações.
- 2026-10-08 — Score (decisões do Felipe): a IA passa a ser a **Celeris** (`celeris-1-magnus`, US$ 0,20 / 0,70 por milhão de tokens de entrada / saída, ~US$ 0,0006 por lead), escolhida por `SCORE_IA=celeris` no `.env`; o Claude continua como alternativa (`SCORE_IA=anthropic`). O Felipe concordou em enviar as conversas, mascaradas, à Celeris (a Poli já usa). Rodadas de **2 em 2 horas, das 08:00 às 18:00, todos os dias** (`SCORE_HORARIOS`), em vez de uma por dia às 05:00.
- 2026-10-08 — Transferência entre SDRs (caso Samuel Marques: Iago → Jessica → Isadora; o lead escreveu no segundo em que estava com a Jessica e a Poli não encerrou o atendimento dela): a transferência encerra o atendimento anterior; mensagens do lead ainda sem resposta passam para quem recebeu (espera em "Aguardando"/"Parados" contando desde a mensagem do lead; a resposta conta na 1ª resposta e no tempo de resposta de quem recebeu); o que o SDR anterior fez continua com ele. Para closer: sai dos números do SDR. Para a fila: fica com quem transferiu. Lead que só passou pelo SDR em evento de sistema sai da lista dele (nota de descarte continua). Vale para o passado (rebuild-all). `chat_messages.poli_sdr_id` = dono segundo a Poli; `sdr_id` = dono efetivo. Migration `20261008230000_transferencia.sql`. No ar em 08/10/2026 (main d24fea4; rebuild-all de 4.218 leads).
- 2026-10-09 — Duração padrão da reunião na tela Agendar: 60 min (era 30). O SDR ainda pode escolher 30 ou 45 ou digitar outra. Reagendar mantém a duração da própria reunião.
- 2026-10-09 — Guilherme também consulta o banco pelo Claude dele, do mesmo jeito que o Timóteo: conector MCP oficial do Supabase, só leitura, restrito ao projeto `pabbgxaphooftdsdewmq` (pedido do Felipe). Vê o banco inteiro, inclusive telefones completos e eventos crus.
- 2026-10-09 — Antecedência mínima para agendar: **0 h** (era 2 h; muda o padrão aprovado para a 10b). O SDR pode agendar para qualquer horário a partir de agora. O Felipe zera o campo em cada carrossel pela tela Carrosséis; o padrão de carrossel novo passa a 0 (migration `20261009120000_antecedencia_zero.sql`).
- 2026-10-09 — "Respondeu template" automático (melhoria fora do roteiro, pedida pelo Felipe): o follow-up do n8n só manda mensagem para Lead com `respondeu_template` desmarcado, e o SDR esquecia de marcar. O worker passa a marcar `respondeu_template = true` no Lead do HubSpot quando o lead escreve qualquer mensagem (inclusive resposta automática do WhatsApp Business), em até 1–2 min. Só marca, nunca desmarca; marca o Lead do ciclo em que o lead respondeu (mensagem depois da criação do Lead anterior do contato e no máximo 1 dia antes da criação deste). Acerto do passado: marca os Leads que já tinham resposta. Alerta no Gestão SDR se falhar por mais de 15 min. Migration `20261009130000_respondeu_template.sql`. No ar em 09/10/2026 (main 9616577); acerto do passado: 1.283 Leads (o Felipe escolheu marcar todos, inclusive Descartado/DSQ/Qualificado). Limite: o painel só conhece Leads modificados no HubSpot desde 25/09.
- 2026-10-09 — Campos do HubSpot já preenchidos pela integração PoliChat-Hubspot (o painel não escreve neles): no Contato, `poli_ultima_mensagem_em`, `poli_direcao_ultima_mensagem`, `poli_aguardando_resposta` (contactProperties.ts) e `poli_prospeccao_iniciada_em`, `poli_template_da_prospeccao`, `poli_primeira_resposta_em`, `poli_tempo_ate_resposta_horas` (prospectingCycle.ts). Em aberto: quais outros campos o Felipe quer que o painel preencha (candidato: `resultado_da_reuniao` no Lead).

## 9. Primeira mensagem ao Felipe

Depois de ler tudo, responda ao Felipe com:
1. Uma linha confirmando que entendeu o projeto.
2. O próximo passo (item 0.1 da seção 4) e o que ele vai precisar fazer com as próprias mãos nele.
Então execute os itens 0.1 a 0.3, parando no 0.2 para ele preencher o `.env`.
