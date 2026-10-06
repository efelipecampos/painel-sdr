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
- [ ] Fase 6 — Reuniões do HubSpot.
- [ ] Fase 7 — Score de qualidade.
- [ ] Fase 8 — Operação (conferência diária, alertas, backup, revisão de segurança).
- [ ] Fase 9 — SDR Modelo (ideia do Felipe, 2026-10-06): o gestor configura o SDR Ideal (faixas e pesos por comportamento: volume, 1ª resposta, tempo de resposta, taxa de resposta, descartes, reuniões validadas); a IA analisa periodicamente os melhores atendimentos (reunião validada / lead de alta qualidade) e sugere ajustes ao SDR Ideal com dados reais, que o gestor aprova ou não; cada SDR ganha uma aderência ao SDR Modelo com o detalhe de onde está dentro e fora. Depende das Fases 6 e 7.

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
| Ligar ou não a nota diária no HubSpot (`DAILY_NOTES_ENABLED`) | Depois da Fase 2 |
| Carteira: qual objeto/campo do HubSpot define "lead em aberto no funil do SDR" | Fase 6 |
| Critérios reais de qualidade do lead e contexto para o Claude | Fase 7 |
| Modelo e limite de gasto da API da Anthropic | Fase 7 |
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
- 2026-10-05 — Sem histórico anterior e sem API da Poli por enquanto: o painel começa em 01/10/2026 07:08 (primeiro evento em `raw_events`). Chats que já existiam antes disso podem ter "quem iniciou" e a primeira resposta imprecisos. A ideia de backfill desde 25/09 foi abandonada.
- 2026-10-05 — Felipe conferiu 3 chats reais no Poli (linha do tempo e tempos de resposta): tudo certo.
- 2026-10-05 — Lia passa a ser SDR também na integração (`POLI_SDR_EMAILS` do `.env` da VPS). Efeito colateral aceito: as mensagens dela passam a ser registradas no HubSpot, como as dos outros SDRs.

## 9. Primeira mensagem ao Felipe

Depois de ler tudo, responda ao Felipe com:
1. Uma linha confirmando que entendeu o projeto.
2. O próximo passo (item 0.1 da seção 4) e o que ele vai precisar fazer com as próprias mãos nele.
Então execute os itens 0.1 a 0.3, parando no 0.2 para ele preencher o `.env`.
