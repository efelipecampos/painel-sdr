# Módulo de agendamento e carrossel de reuniões (Fase 10)

Pedido do Felipe em 2026-10-06. Leia junto com `docs/COMECE-AQUI.md` (regras de condução e pontos de parada) e com as decisões de reunião já registradas lá (status, Fase 6 enxuta).

Telas de referência: `design/Agendar.dc.html` (SDR), `design/Reunioes.dc.html`, `design/Carrossel.dc.html` e `design/Usuarios.dc.html` (gestor/admin).

## 0. O que já existe hoje: Poli Agenda

A Poli já usa uma ferramenta própria de agendamento, a **Poli Agenda**, em produção. Este módulo a **substitui** dentro do Painel SDR. O que ela faz hoje (visto nas telas enviadas pelo Felipe em 2026-10-06):

- Fluxo em 4 telas: escolher a empresa (Poli ou ChatsHub) → escolher o carrossel → escolher o dia num calendário mensal e a hora numa lista de hora em hora (07:00–19:00) → preencher o formulário (link ou ID do Lead no HubSpot, nome, empresa, site, SDR responsável, convidados).
- No formulário existe "Ajustar hora e minuto", que permite mudar o horário depois de escolhido.
- **Vários carrosséis**, por empresa e porte do cliente. Poli: Clientes até 5 usuários, Clientes de 6 a 10 usuários, Acima de 10 usuários, Licitação. ChatsHub: os mesmos da Poli, menos Licitação (confirmado pelo Felipe em 2026-10-07). São 7 carrosséis independentes: cada um com seus closers, pesos e saldo.
- Cada carrossel tem seus closers, com peso e liga/desliga. A distribuição é por ciclo ("Ciclo: 1/1", e já aparece "2/1", ou seja, o ciclo estoura).
- Closers conectam a própria agenda do Google, um a um. Existe uma "agenda de arquivo" (conta de um gestor) que recebe as reuniões canceladas, no show e reagendadas.
- Telas de admin: Dashboard, Closers, SDRs, Carrosséis, Reuniões do dia.
- Na lista de reuniões, evento apagado no Google aparece riscado como "Removida no Google", sem ação de correção.
- Links separados para reagendar e para registrar cancelamento ou no show.

**Problemas relatados pelo Felipe:** disponibilidade de agenda (principal), formato de visualização e sequência das telas.

**Hipóteses do que causa isso (tiradas das telas; o código da Poli Agenda não será lido, então valide com 1 ou 2 casos reais que o Felipe trouxer):**
1. Horários só de hora em hora: perde os encaixes de :30 e some com dias que teriam vaga.
2. O calendário mensal mostra todo dia útil como disponível; o SDR precisa clicar dia por dia para achar horário.
3. "Ajustar hora e minuto" permite gravar um horário que não passou pela checagem de disponibilidade.
4. O SDR consegue influenciar quem recebe a reunião trocando o horário (ver "Closer às cegas", seção 5).
5. A disponibilidade depende do carrossel escolhido três telas antes; se o carrossel estiver errado, o SDR só descobre no fim.
6. Evento apagado pelo closer no Google vira linha morta e ninguém resolve.

O desenho novo ataca cada um: uma tela só, grade semanal com todos os horários livres de 30 em 30 min, sem ajuste manual de horário, closer oculto até a confirmação, e fila de "Com problema" na lista de reuniões.

## 1. O que muda no produto

Até aqui o painel só lê dados. Com este módulo ele passa a **operar**: SDRs entram na ferramenta, criam reuniões na agenda dos closers e o sistema decide para qual closer a reunião vai. Consequências:

- Se o painel cair, o time para de agendar. Antes de liberar para os SDRs: backup e alerta da Fase 8 prontos, e Supabase no plano Pro.
- O painel passa a ESCREVER fora dele: Google Agenda e HubSpot. Tudo que escreve fora é ponto de parada (COMECE-AQUI, seção 2).
- A reunião passa a ter data, hora e closer. Isso resolve a pendência "data da reunião" da Fase 6.

## 2. Decisões já tomadas (2026-10-06)

- Agenda dos closers: **Google Agenda**.
- **Vários carrosséis** (empresa × porte), como hoje. O SDR escolhe empresa e carrossel na própria tela de agendamento; a troca recalcula os horários na hora.
- Carrossel no modo **horário primeiro**: o SDR vê todos os horários em que pelo menos um closer está livre; ao escolher, o sistema dá a reunião ao closer livre que está mais atrás na distribuição.
- SDR vê **só o que é dele**: os próprios chats, os próprios números e o agendamento.
- Duas entradas para agendar: botão **Agendar reunião** no topo da tela do SDR (escolhe o lead) e botão **Agendar** na linha de cada lead (lead já preenchido).
- Gestores e admin configuram **pesos** por closer.
- **Almoço igual para todos os closers: 12:00 a 13:30** (a grade não oferece esse intervalo). **Limite absoluto do ajuste manual: 07:00 a 20:00.** Confirmado pelo Felipe em 2026-10-07. Os dois ficam em configuração.
- **Closer às cegas (2026-10-07):** o SDR não vê nem escolhe o closer antes de confirmar. Motivo, nas palavras do Felipe: o SDR prioriza o closer de quem gosta e, se enxerga o closer antes, troca o horário para a reunião cair em outro. Regras completas na seção 5.
- **Dados do lead vêm do HubSpot (2026-10-07):** ao abrir o agendamento, o sistema traz o máximo de dados do lead. O SDR não redigita o que o HubSpot já tem.
- **Carrossel sugerido pelo HubSpot (2026-10-07):** a propriedade de contato `sdr_2_0__quantidade_de_usuarios_a_utilizar_a_plataforma` ("[SDR 2.0] Quantidade de usuários a utilizar a plataforma") sugere o carrossel (até 5 / 6 a 10 / acima de 10). O SDR pode trocar.
- **Aviso de pedido de troca de closer (2026-10-07):** vai para o espaço **"Gestão SDR"** do Google Chat (webhook do espaço no `.env`), além da fila no painel.
- **Disponibilidade da Poli Agenda (2026-10-07):** não há casos reais documentados. Seguir as hipóteses da seção 0 e validar no piloto, registrando toda falha de agenda com horário, closer e a resposta do Google.
- **Padrões aprovados para a 10b (2026-10-07):** equilíbrio por **mês**; No show e Cancelada **devolvem** a vez, Invalidada **não**; antecedência mínima **2 h**; janela **10 dias úteis**; intervalo entre reuniões **15 min**; durações **30, 45 e 60 min**; lead preso ao mesmo closer por **30 dias**.

## 3. Quem usa

- Novo papel `sdr` em `painel.app_role`, ligado ao SDR dele (`profiles.sdr_id`).
- Toda RPC que a tela do SDR chama precisa restringir pelo SDR do usuário logado **no banco** (não só esconder na tela). SDR não acessa `/`, `/configuracoes` nem a tela de outro SDR.
- Admin e gestor continuam vendo tudo e ganham a tela do carrossel.
- Closers não viram usuários nesta fase. Eles recebem a reunião pela Google Agenda.

## 4. Fluxo do SDR

1. Abre o agendamento:
   - pela linha do lead na tela dele: o painel já conhece o contato do HubSpot (`leads.hubspot_contact_id`) e carrega tudo sozinho;
   - pelo botão do topo: busca entre os leads dele por nome ou telefone e escolhe; o resto carrega sozinho;
   - **link ou ID do HubSpot é só o plano B**, para quando o lead não aparece na busca (lead sem chat no painel, ou chat cujo contato a integração não conseguiu ligar ao HubSpot). Aceitar link de Contato e de Lead, e ID puro. Quando o SDR usa o link para um lead que tem chat, gravar a ligação (`leads.hubspot_contact_id`) para não pedir de novo.
2. O sistema consulta o HubSpot **na hora** (não usar só a cópia do sync, que pode ter até 15 min) e preenche: nome, empresa, e-mail, telefone, site, dono, etapa do Lead e, se existir a propriedade, o número de usuários, que sugere o carrossel. O SDR confere, corrige o e-mail se precisar, escolhe empresa e carrossel, a duração, ajusta o título e escreve a passagem de bastão.
3. Escolhe um horário na grade e, se precisar, **ajusta livremente o início e a duração** (pedido do Felipe em 2026-10-07: horários quebrados, almoço e depois das 18h acontecem). Regras do ajuste:
   - Início em qualquer minuto; duração livre (padrão 10 a 240 min), com atalhos de 30, 45 e 60.
   - A cada mudança o sistema **confere de novo a agenda real** para o intervalo exato e mostra quantos closers estão disponíveis. Zero closers: não deixa confirmar. É isso que faltava no "Ajustar hora e minuto" da Poli Agenda.
   - A grade só oferece horários do expediente padrão (fora do almoço, até as 18h). O ajuste manual pode sair disso, dentro de um limite absoluto configurável (padrão 07:00 a 20:00). Nesse caso a tela avisa ("Pega o horário de almoço", "Termina depois das 18:00") e a reunião fica **marcada como fora do horário padrão** na lista dos gestores.
   - O intervalo entre reuniões continua valendo no ajuste manual.
   - O servidor repete todas essas checagens na confirmação; a tela não é a única barreira.
   Cada horário mostra **quantos closers estão disponíveis** ("1 closer disponível", "2 closers disponíveis"), pedido do Felipe em 2026-10-07. Nunca o nome.
4. Confirma. O sistema, nesta ordem, no servidor:
   1. Trava a distribuição, escolhe o closer pelo carrossel, confere de novo se ele continua livre e grava a reunião.
   2. Cria o evento na Google Agenda do closer, com link do Meet, convidando o lead (se houver e-mail).
   3. Marca o lead como **Agendada** no painel (origem `painel`), com data, hora e closer.
   4. Move o Lead no HubSpot para "Garantir Agendamento".
   Se o passo 2 falhar, desfaz o 1 e avisa o SDR. Se o 4 falhar, mantém a reunião e tenta de novo em segundo plano.
5. Só então a tela mostra o closer e o link do Meet.

Lead não encontrado no HubSpot: não agenda. O lead precisa existir lá primeiro.
Sem e-mail do lead: o evento vai só para o closer e a tela mostra o link do Meet para o SDR mandar pelo WhatsApp.

## 5. Regra do carrossel

**Horários oferecidos:** dentro do horário comercial e fora de feriados (configurações que já existem), respeitando antecedência mínima, janela máxima de dias úteis e intervalo entre reuniões. Um horário aparece se ao menos um closer elegível está livre nele.

**Closer elegível:** ativo no carrossel, peso maior que zero, agenda conectada, livre no horário (free/busy do Google + reuniões já gravadas no painel + intervalo).

**Cada carrossel tem o seu livro-caixa.** Um closer pode estar em vários carrosséis, com peso diferente em cada um. A agenda dele é uma só: horário ocupado por reunião de um carrossel fica indisponível nos outros.

**Distribuição por saldo (livro-caixa).** Não usar "esperado = fatia × total do mês": isso quebra quando o peso muda ou alguém entra ou sai no meio do período. Usar um livro-caixa (`carousel_ledger`):

- A cada reunião distribuída, cada closer **ativo no carrossel naquele momento** (livre ou não) recebe um crédito de `peso ÷ soma dos pesos dos ativos`.
- O closer que recebe a reunião tem um débito de 1.
- Saldo do closer = créditos − débitos no período de equilíbrio.
- Entre os elegíveis e livres no horário escolhido, **ganha o de maior saldo**. Empate: quem recebeu reunião há mais tempo; persistindo, ordem alfabética.
- Closer pausado ou sem agenda conectada não acumula crédito (não "deve" reuniões quando volta).
- Mudança de peso vale só para as próximas distribuições.

**Período de equilíbrio:** mês ou semana (configurável). O saldo zera no início de cada período.

**Reunião que não aconteceu:** conforme a configuração, No show e Cancelada estornam o débito do closer (ele volta a ter saldo e recebe uma das próximas). Invalidada não estorna por padrão.

**Closer às cegas (regra de segurança, não só de tela):**

- Nenhuma resposta do servidor para o papel `sdr` pode conter nome, id ou qualquer identificação de closer antes da confirmação. A RPC de horários devolve, por horário, só a hora e a **quantidade** de closers disponíveis. Testar isso (a resposta de `horarios_disponiveis` para um SDR não tem nenhum campo que identifique closer).
- Limite conhecido e aceito: num horário com 1 closer disponível, um SDR que consulte a agenda dos colegas no Google consegue deduzir quem é. O painel não tem como impedir isso; as defesas são as regras abaixo (lead preso ao closer e relatório de cancelamentos).
- **Troca de closer por pedido e aprovação (2026-10-07).** O SDR não troca closer sozinho. Ele clica em "Pedir troca de closer" (na tela de sucesso e em Minhas reuniões), escreve a justificativa (obrigatória) e o pedido entra numa fila.
  - O responsável por decidir é o **gestor de SDR, hoje o Iago Leal** (definido pelo Felipe em 2026-10-07). No sistema é um usuário marcado como aprovador principal nas configurações, para poder mudar sem mexer em código. **Qualquer gestor ou admin** também pode aprovar ou recusar, para cobrir férias e ausência.
  - Aviso do pedido: no painel (fila no topo da lista de Reuniões, com contagem) e por **Google Chat** para o aprovador principal (definido pelo Felipe em 2026-10-07). A mensagem traz SDR, lead, horário, closer atual, justificativa e o link direto para a fila. Usar webhook de um espaço do Google Chat, como a integração PoliChat-Hubspot já faz nos alertas dela (`src/alerts/googleChat.ts`); a URL do webhook fica no `.env`.
  - **Antes de abrir o pedido, o sistema confere se existe outro closer do carrossel disponível naquele horário.** Se não existir, o pedido não é enviado e o SDR vê um popup avisando (pedido do Felipe em 2026-10-07). A mesma checagem roda de novo na hora de aprovar, porque a agenda pode ter mudado; se não sobrar ninguém, quem aprova é avisado e pode recusar ou trocar também o horário.
  - O SDR **não escolhe o novo closer**. Quem aprova escolhe: deixar o carrossel decidir entre os livres no horário (padrão, excluindo o closer atual) ou indicar um closer livre.
  - Enquanto o pedido está pendente, a reunião continua com o closer atual. Um pedido pendente por reunião.
  - Se ninguém decidir até X horas antes da reunião (padrão 2 h), o pedido expira e a reunião segue como está.
  - Aprovado: estorna o débito do closer antigo, debita o novo, move o evento de agenda e avisa os dois closers e o SDR. Recusado: avisa o SDR, com motivo opcional.
  - Tudo fica gravado: quem pediu, justificativa, quem decidiu, quando, de quem para quem.
- **Lead mantém o mesmo closer.** Reagendar mantém o closer; a grade de reagendamento mostra só os horários livres dele. Cancelar e agendar de novo o mesmo lead dentro de N dias (padrão 30, configurável por carrossel) cai no mesmo closer, se ele estiver ativo. Sem isso, o SDR vê o closer depois de agendar e "roda de novo" cancelando e remarcando.
- Se o closer do lead não tiver nenhum horário na janela, o SDR usa o mesmo pedido de troca.
- Relatório para os gestores: por SDR, quantas reuniões foram canceladas ou reagendadas em até 1 hora depois de criadas, e quantos pedidos de troca fez (aprovados e recusados). É o sinal de tentativa de burlar.

**Troca direta por gestor ou admin** (sem pedido do SDR): mesma mecânica de saldo e registro, com justificativa de quem trocou.

**Reagendamento:** sempre com o mesmo closer (ver "Lead mantém o mesmo closer"). Não mexe no saldo.

**Concorrência:** dois SDRs podem escolher o mesmo horário ao mesmo tempo. A confirmação roda numa transação com trava (advisory lock do carrossel), reconsulta o free/busy do closer escolhido e, se ele ficou ocupado, recalcula entre os que sobraram ou devolve erro pedindo outro horário.

**Testes obrigatórios** (simulação, sem Google): distribuição de 200 reuniões com pesos 3/2/2/1 termina com no máximo 1 de diferença da fatia; closer pausado no meio não acumula crédito; mudança de peso no meio não redistribui o passado; estorno de no show devolve a vez; empate resolvido de forma determinística; duas confirmações simultâneas no mesmo horário nunca geram duas reuniões para o mesmo closer.

## 6. Google Agenda

**Decisão (2026-10-07): construir do zero, sem reaproveitar código, banco nem projeto do Google da Poli Agenda (feita no Lovable).** O Felipe não quer herdar nada de lá.

Caminho B (cada closer conecta a própria agenda uma vez), com um projeto NOVO no Google Cloud:

- O projeto precisa ser criado **dentro da organização poli.digital** e a tela de consentimento marcada como **Interna**. Assim não exige verificação do Google e a conexão não expira.
- Se for criado fora da organização (tipo Externo, em modo de teste), o Google derruba a conexão de cada closer a cada 7 dias e limita a 100 usuários. A agenda "some" sem aviso. Não usar esse modo. É uma causa provável dos problemas de disponibilidade de hoje (hipótese, não verificada).
- Todos os closers reconectam a agenda uma vez, pela tela de Usuários ("Enviar link de conexão").
- O caminho A (conta de serviço com delegação no domínio) continua como melhoria futura.

Manter também a **agenda de arquivo**: reuniões canceladas, no show e reagendadas são movidas para ela, para o histórico não sumir da agenda.

Em qualquer caminho:
- Permissões mínimas: ler disponibilidade (free/busy) e criar/alterar eventos. Nada de ler o conteúdo dos eventos dos closers.
- Evento criado com Meet, título, convidados e lembretes padrão.
- **Passagem de bastão não vai na descrição do evento** quando o lead é convidado: todo convidado lê a descrição. Ela fica gravada no painel e chega ao closer por um canal só dele (e-mail separado ou alerta no Google Chat, como a integração já faz). Canal a decidir com o Felipe.
- Guardar `google_event_id` e `meet_url`.
- Cancelar ou reagendar no painel atualiza o evento.
- V1: um job confere periodicamente se o evento ainda existe e se o closer recusou. Notificações em tempo real do Google ficam para depois.
- Credenciais do Google só no servidor (`.env` da VPS). Token de closer (caminho B) cifrado no banco.

## 7. HubSpot

- Consulta ao vivo do lead ao abrir o agendamento (seção 4): Contato e Lead associado, por link ou ID. Só leitura.
- Ao agendar: mover o Lead para "Garantir Agendamento" (etapa já mapeada em `settings.hubspot_agendado_stages`). O token do app privado precisa de **escrita** em Leads; hoje só lê.
- O objeto Reunião do HubSpot continua fora (decisão de 2026-10-07), salvo decisão nova do Felipe.
- A regra "o HubSpot nunca sobrescreve marcação manual" continua. Reunião criada pelo painel tem origem `painel` e também não é sobrescrita.

## 8. Dados (rascunho; adaptar ao schema real)

- `painel.app_role`: acrescentar `sdr`. `painel.profiles`: acrescentar `sdr_id`.
- Closers: reaproveitar `painel.sdrs` com `role = 'closer'` (já existe `team_role`).
- `painel.carousels`: `id`, `brand` (`poli` | `chatshub`), `name`, `description`, `active`, regras próprias (período de equilíbrio, estornos, antecedência, janela, intervalo, dias de "lead mantém o mesmo closer").
- `painel.carousel_members`: `carousel_id`, `closer_id`, `weight`, `active`, `updated_by`, `updated_at`.
- `painel.carousel_ledger`: `carousel_id`, `closer_id`, `kind` (`credit` | `debit` | `refund`), `amount`, `meeting_id`, `period_key`, `created_at`.
- `painel.closer_calendars`: `closer_id`, `google_calendar_id`, `status`, `last_checked_at` (+ token cifrado no caminho B).
- `painel.meetings`: acrescentar `carousel_id`, `closer_id`, `starts_at`, `ends_at`, `google_event_id`, `meet_url`, `lead_email`, `handoff_notes`, `created_by`, `assigned_by` (`carrossel` | `manual`), `override_reason`. Origem nova: `painel`.
- `painel.closer_swap_requests`: `meeting_id`, `requested_by`, `reason`, `status` (`pendente` | `aprovado` | `recusado` | `expirado`), `decided_by`, `decided_at`, `from_closer_id`, `to_closer_id`, `decision_note`, `created_at`.
- Configurações novas em `painel.settings`: período de equilíbrio, estornos (no show, cancelada, invalidada), antecedência mínima, janela, intervalo, duração padrão.
- RPCs: `horarios_disponiveis(de, até, duração)`, `agendar_reuniao(...)`, `reagendar_reuniao(...)`, `cancelar_reuniao(...)`, `carrossel_resumo(período)`, `carrossel_definir_peso(...)`. Todas checam papel no banco.

## 9. Telas

Navegação do gestor e do admin: Painel · Reuniões · Carrosséis · Usuários · Configurações. O SDR vê: Meus chats · Minhas reuniões · Agendar.

- **Agendar** (`/agendar`, `/agendar?lead=...`), `design/Agendar.dc.html`: uma tela só. Lead, empresa e carrossel, duração, convite e passagem de bastão à esquerda; grade da semana e confirmação à direita. O closer e o link do Meet só aparecem na tela de sucesso, depois de confirmar. Busca do lead por link ou ID do HubSpot no topo. Entradas: botão no topo da tela do SDR e botão por linha de lead. Admin e gestor podem agendar em nome de um SDR.
- **Reuniões** (`/reunioes`), `design/Reunioes.dc.html`: lista por dia, com filtros por situação (com contagem), carrossel, SDR, closer e busca. Situação editável (os 5 status). Ações: Reagendar, Abrir Meet. Fila **Com problema**: evento apagado da agenda do closer, com "Recriar evento" ou "Marcar como cancelada". No topo, a fila **Pedidos de troca de closer** (SDR, lead, closer atual, justificativa, escolha do novo closer, Aprovar e Recusar). Gestor e admin também têm a ação Trocar closer direta; a lista mostra quando houve troca. Na visão do SDR (Minhas reuniões) a ação é Pedir troca de closer. O SDR vê só as dele.
- **Carrosséis** (`/carrosseis`), `design/Carrossel.dc.html`: lista dos carrosséis por empresa à esquerda; à direita, o carrossel selecionado: nome, quando usar, empresa, closers com peso, fatia, recebidas × esperado, e as regras. Criar e arquivar carrossel.
- **Usuários** (`/usuarios`, só admin), `design/Usuarios.dc.html`: todos os usuários numa lista (admin, gestor, SDR, closer), com papel, empresa, carrosséis do closer, situação da agenda do Google (com "Enviar link de conexão") e ativo/inativo. Substitui o script `npm run usuarios` e as telas Closers e SDRs da Poli Agenda.

## 10. Ordem de construção

1. **10a — Acesso do SDR:** papel `sdr`, RLS por SDR, tela dele. Sem agendamento ainda.
2. **10b — Carrossel sem Google:** pesos, livro-caixa, tela do gestor e todos os testes da seção 5, com disponibilidade simulada.
3. **10c — Google Agenda:** conexão, free/busy, criar/alterar/cancelar evento, testado com 1 closer piloto.
4. **10d — Agendar de ponta a ponta:** tela `/agendar`, botões, confirmação com trava, link do Meet.
5. **10e — HubSpot e pós-agendamento:** mover Lead, reagendar, cancelar, estornos.
6. **Virada da Poli Agenda (sem migração de código nem de banco):**
   1. Cadastrar à mão closers, carrosséis e pesos nas telas novas (são poucos).
   2. Todos os closers conectam a agenda.
   3. Piloto com 1 ou 2 SDRs por uma semana. Os demais continuam na Poli Agenda. Como as duas leem a mesma Google Agenda, não há risco de marcar em cima: o que uma agenda, a outra vê como ocupado.
   4. Data de corte: a partir dela, ninguém agenda mais na Poli Agenda.
   5. Reuniões já marcadas pela Poli Agenda para depois do corte: continuam valendo na agenda do Google dos closers. No painel novo elas não aparecem na lista nem contam no saldo, a menos que o Felipe peça para lançá-las à mão. Os saldos de todos os carrosséis começam zerados no corte.
   6. Desligar a Poli Agenda.

## 10.1 Pedidos do Felipe em 2026-10-07 (entendimento registrado; detalhes em aberto na seção 11)

**A. Troca de marca durante a reunião ("Passar para CH" / "Passar para Poli").** Durante a reunião o closer entende a situação real do cliente e a reunião muda de empresa. O **closer entra no sistema**, acha a reunião dele na lista e clica num botão só. Isso muda o nome da reunião no painel e no Google Calendar na hora; o HubSpot é atualizado no fim do dia (item B). Consequência: **closer passa a ser usuário do painel** (antes: "closers não entram nesta fase"), vendo só as próprias reuniões.

**B. HubSpot: reunião criada no agendamento + atualização diária às 17:55.** Toda reunião agendada gera uma **Reunião no HubSpot associada** ao Lead, ao contato, ao closer e ao SDR. Todo dia às **17:55** o painel envia ao HubSpot os status do dia (validada, invalidada, no show, cancelada etc.). Motivo: a Poli Agenda e a extensão do HubSpot atualizam tudo na hora e geram **reuniões duplicadas**, e o time recontava as reuniões à mão todo dia. Regra de ouro: **uma reunião do painel = uma reunião no HubSpot, para sempre** (guardar o id e sempre atualizar, nunca criar de novo). Substitui a decisão de 2026-10-07 "objeto Reunião do HubSpot fica fora".

**C. "Editar" e "Reagendar" na lista do SDR.** Em vez de "Abrir Meet", a linha tem **Editar**: mudar o **horário** da reunião. **Reagendar**: mudar o **dia** (e talvez o closer). Reagendar **move o convite** na agenda (o mesmo evento), e **não pode duplicar no HubSpot** de jeito nenhum.

**D. Reaproveitar a reunião do lead.** Lead cancelou e volta dias depois: em vez de nova reunião, o SDR acha a reunião anterior e clica em **Reagendar** (a nova substitui a antiga; no HubSpot continua sendo a mesma reunião). Na tela **Agendar**, mostrar de forma simples **"Reuniões já agendadas com este lead"**: data, closer e resultado (validada, invalidada...), com atalho para reagendar.

## 11. Pendências para decidir com o Felipe

| Pendência | Quando |
|---|---|
| Agendas no Google: quem na Poli tem acesso de administrador ao Google Workspace / Google Cloud para criar o projeto novo como app **interno** da organização | Antes da 10c |
| Virada: data de corte e como tratar as reuniões já marcadas na Poli Agenda (seção 10, passo 6) | Antes da 10d |
| Quais outros campos do HubSpot o SDR e o closer precisam ver no agendamento | 10d |
| Prazo para o pedido de troca expirar antes da reunião (padrão 2 h) | 10e |
| Lead sem e-mail: bloquear ou permitir (padrão: permitir) | 10d |
| Por onde o closer recebe a passagem de bastão: e-mail separado ou Google Chat | 10c |
| O SDR entra como convidado no evento? | 10c |
| Liberar escrita de Leads no token do HubSpot | Antes da 10e |
| (A) Trocar de marca: a reunião muda de carrossel (Poli ↔ ChatsHub do mesmo porte)? E o livro-caixa (o crédito/débito vai para o carrossel novo)? Formato do nome da reunião | 10b/10e |
| (A) Closer como usuário: vê só as próprias reuniões? Também marca validada/invalidada/no show? Login com e-mail do Google Workspace | 10e |
| (B) A agenda dos closers está ligada ao HubSpot (sincronização de calendário / ferramenta de reuniões / extensão)? Se estiver, o HubSpot já cria a reunião sozinho a partir do convite — e o painel criando também duplica | Antes da 10c |
| (B) Criar a Reunião no HubSpot na hora do agendamento, ou também só às 17:55? E mover o Lead para "Garantir Agendamento": na hora ou às 17:55? | Antes da 10e |
| (B) Como cada status vira no HubSpot (resultado da reunião: agendada, realizada, no show, cancelada, reagendada) e onde ficam validada/invalidada (propriedade nova?) | Antes da 10e |
| (C) Editar (horário) e Reagendar (dia): mesmo closer sempre, ou reagendar pode mudar o closer pelo carrossel? (conflita com "lead mantém o mesmo closer") | 10d |
| (D) Reagendar uma reunião cancelada: o evento volta da agenda de arquivo para a agenda do closer, com o mesmo id no HubSpot? | 10d |
| Criar o webhook do espaço "Gestão SDR" no Google Chat (o Felipe cria e cola no `.env`) | 10e |
| Quem pode reagendar e cancelar: SDR dono, closer, gestor | 10e |

## 12. Prompt para iniciar

> Leia docs/COMECE-AQUI.md e docs/agendamento.md. Vamos começar a Fase 10 pela etapa 10a (acesso do SDR). Antes de codar, leia a seção 0 (o que a Poli Agenda faz hoje; vamos construir do zero, sem reaproveitar nada dela), me faça as perguntas da seção 11 marcadas "Antes da 10b" e me mostre o plano da 10a: migrations, mudanças de RLS e como você vai provar com testes que um SDR não consegue ler dados de outro SDR. Siga os pontos de parada.
