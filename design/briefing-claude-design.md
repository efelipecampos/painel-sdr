# Painel SDR: briefing para o Claude Design

Atualizado em 15/10/2026. Junte este arquivo ao projeto no Claude Design com `tokens.json` e os protótipos `*.dc.html` desta pasta. Os protótipos foram o ponto de partida; este briefing diz o que mudou desde eles e o que falta desenhar.

## 1. O produto

Painel interno da Poli Digital para acompanhar os SDRs no Poli Chat (WhatsApp), agendar reuniões com os closers e, em seguida, mostrar onde cada SDR precisa de treino.

- Português do Brasil, fuso de São Paulo.
- Tema escuro da Poli (`tokens.json`). Amarelo (`--stale`) marca o que pede atenção: lead aguardando resposta, avisos de horário.
- Desktop primeiro. Uso diário pelos SDRs, com a tela aberta o dia todo.

## 2. Quem usa

| Papel | Vê no menu | Para quê |
|---|---|---|
| SDR | Meus chats · Reuniões (só as dele) · Agendar | Atender leads, marcar reunião, acompanhar os próprios números |
| Closer | Reuniões (só as dele) · Minha agenda | Ver as reuniões e a passagem de bastão; conectar o Google Agenda |
| Gestor | Painel · Reuniões · Agendar · Carrosséis · Relatório · Jornada · Alertas · Configurações | Acompanhar o time, corrigir reuniões, ajustar regras e a jornada do lead |
| Admin | Tudo do gestor + Usuários + Teste da agenda | Cadastrar pessoas e papéis |

## 3. Telas que já existem

### Entrada
- **Login**, **Esqueci minha senha**, **Definir senha** (link do convite por e-mail).

### Painel (gestor): "Resumo do time"
- Período de/até no topo.
- Um card por SDR: templates enviados, cadastros sem disparo, leads abordados, leads que responderam, aguardando resposta, e "Ver chats ›".
- Só entram SDRs (robôs e gestores ficam fora dos números).

### Meus chats / tela do SDR
- Indicadores do SDR no topo: templates enviados, leads abordados, leads que responderam, resposta (mediana).
- Tabela de chats com busca e filtros. Colunas: lead, origem (marcado à mão / via HubSpot), situação, mensagens (lead/equipe), última mensagem, qualidade (score da IA), reunião, ações.
- Situações: aguardando resposta (linha em amarelo), respondido, lead não respondeu, encerrado sem resposta, com reunião, no show.
- Ações por linha: Agendar, Abrir no Poli, Finalizar / Desfazer finalização.
- Lead descartado que recebe template novo volta para a lista ("reativação").

### Agendar (`Agendar.dc.html`) e Reunião agendada (`AgendarSucesso.dc.html`)
- Busca do lead por link ou ID do HubSpot; dados do lead, empresa, etapa e dono no HubSpot.
- Avisos: "Este lead já tem reunião", reuniões do contato feitas fora do painel.
- Carrossel (tamanho do cliente), duração, título do convite, outros convidados e passagem de bastão (só a equipe vê).
- Grade da semana com horários livres e a quantidade de closers em cada um. O closer só aparece depois de confirmar.
- "Ajustar hora e minuto": fora do padrão pede confirmação.
- Gestor e admin agendam em nome de um SDR.
- Sucesso: closer, link do Meet, "Agendar outra" e "Ver minhas reuniões".

### Reuniões (`Reunioes.dc.html`)
- Lista por dia (Anterior · Hoje · Próximo), filtros por situação com contagem, carrossel, SDR, closer e busca.
- Situação editável: agendada, validada, no show, cancelada, entre outras.
- Fila **Com problema**: evento apagado da agenda do closer, closer ou lead recusou o convite, "Mudou no Google". Ação **Recriar evento**.
- Fila **Pedidos de troca de closer**: justificativa do SDR, novo closer, Aprovar e Recusar.
- Ações por papel:
  - SDR: **Reagendar**, só para horários livres, com as travas do carrossel; e **Pedir troca de closer**.
  - Gestor e admin: **Editar** (desde 13/10). Data, hora, duração e closer livres, mesmo ocupado ou sobreposto. O painel só avisa e mostra a situação de cada closer ("livre", "ocupado: reunião com cliente", "a menos de X min de outra reunião"). Também têm **Trocar closer** direto.
- Marcas na lista: "Trocado a pedido do SDR", "Trocado por um gestor", "Marcada fora do horário padrão".

### Passagem de bastão (`/reuniao/[id]`)
- Card da reunião: título, horário, situação, carrossel, closer, SDR, lead, empresa, e-mail, link do HubSpot, link do Meet e o texto da passagem de bastão.

### Carrosséis (`Carrossel.dc.html`)
- Lista por empresa (Poli, ChatsHub) à esquerda; o carrossel selecionado à direita.
- Closers com peso, fatia, recebidas × esperado, pausado pelo gestor.
- Regras: durações, antecedência, janela em dias úteis, intervalo entre reuniões, quanto tempo o lead mantém o closer, se no show devolve a vez.

### Usuários (`Usuarios.dc.html`, só admin)
- Lista com papel (muda na própria linha), empresa, carrosséis do closer, agenda do Google, login e ativo.
- "Adicionar usuário" manda convite por e-mail; "Enviar link de senha".

### Configurações (`Configuracoes.dc.html`)
- Horário comercial, feriados, "destacar como parado depois de X minutos", leads que não recebem nota, agenda de arquivo do Google.
- Qualidade do lead: contexto e critérios com peso para a IA.

### Minha agenda (closer)
- Conectar, reconectar e ver a situação da conexão com o Google Agenda.

### Relatório de agendamentos (gestor)
- Por período: agendadas, canceladas em até 1 h, horário mudado em até 1 h, pedidos de troca (aprovados e recusados).

## 4. Regras que a interface precisa respeitar

- Intervalo do carrossel só entre reuniões **com cliente**: as do painel e os eventos do Google com convidado de fora da empresa (domínios `poli.digital` e `chatshub.com.br`). Almoço e reuniões internas ocupam o horário, mas sem intervalo.
- Ao mudar o horário, a própria reunião não ocupa o closer.
- Reagendar ou editar uma reunião com o evento apagado no Google refaz o evento sozinho.
- O SDR não escolhe o closer: quem decide é o carrossel ou o gestor.
- Dados de lead são pessoais (LGPD): nada de telefone completo nem trecho de conversa em telas que não precisam disso.

## 5. O que vamos desenhar agora

### 5.1 SDR Modelo (Fase 9, especificação aprovada em `docs/sdr-modelo.md`)
Para que serve: mostrar onde cada SDR precisa de treino, para levar ao 1:1. Não é ranking nem bônus.

1. **Visão do time** (gestor): comportamentos nas linhas, SDRs nas colunas, aderência de 0 a 100. Destaca onde o time inteiro está fora da faixa.
2. **Um SDR** (o SDR vê só a dele): aderência, e cada comportamento com valor × faixa ideal, dentro/fora ou "amostra pequena", e exemplos de conversas com link para o chat.
3. **SDR Ideal (configuração, gestor e admin)**: faixas e pesos por comportamento, comportamentos de conversa editáveis (nome, o que a IA olha, ativo), histórico de versões com data e autor, e sugestões semanais da IA para aprovar ou recusar.

Comportamentos:
- **Números:** volume (leads abordados por dia útil), 1ª resposta, tempo de resposta, taxa de resposta, descartes, reuniões validadas, confirmação de reunião.
- **Conversa (IA):** perguntas e gatilhos mentais.

Período de/até, como no painel.

### 5.2 Confirmação de reunião e no show (proposta, a decidir)
Em 13/10 o no show foi de 40%, contra 15% no histórico. Entre os leads que não responderam no dia da reunião, 67% não apareceram; entre os que responderam, 22%. Ideias para desenhar:
- Na lista de Reuniões do dia, a situação da confirmação: confirmou, sem resposta ou não confirmado até 1 h antes.
- Aviso ao closer quando o lead não confirmou.
- Reuniões passadas ainda "agendada" destacadas para o SDR ou o closer marcar o que aconteceu.

### 5.3 Entrega do template (proposta, depende do ACK da Poli)
- Situação de cada template no chat do SDR: enviado → entregue → lido, ou falhou, com o motivo ("número sem WhatsApp").
- Taxas de entrega e de leitura por SDR e por template.
- Lista de leads com número inválido.
- Em aberto: taxa de resposta sobre entregues ou sobre enviados; lead com template não entregue conta em Aguardando?

### 5.4 Jornada · Regras (Fase 11, especificação em `docs/jornada.md`)
Para que serve: o gestor decide o que o painel envia quando o lead clica num botão de um template. Exemplo: clicou "Eu e mais 1" → envia o template de encerramento; clicou "3 ou mais" fora do expediente → envia o template "Manhã ou Tarde". O painel envia de verdade, pelo WhatsApp, em nome da SDR dona do lead.

Só gestor e admin veem.

- **Topo:** situação da jornada (ativa ou pausada) e um botão grande **Pausar jornada**, com confirmação. É o freio de emergência.
- **Lista de regras**, uma linha por regra:
    - "Quando o lead clicar em" (template de origem + botão);
    - "Horário" (expediente, fora do expediente ou sempre);
    - "Enviar" (template de destino);
    - "Situação" (em teste, ativa ou pausada);
    - envios de hoje e falhas de hoje.
- **Criar e editar regra:**
    - escolher o template de origem;
    - escolher o botão entre os botões desse template;
    - escolher o horário e o template a enviar;
    - ver uma prévia do texto que o lead vai receber, com as variáveis preenchidas por um exemplo.
- **Ciclo de vida da regra:** ela nasce **em teste** e só envia para o número de teste. O gestor clica **Ativar** quando o teste der certo. Pode **Pausar** e **Retomar** a qualquer momento.
- **Avisos que a tela mostra:**
    - template com variável que o painel não sabe preencher (bloqueia a ativação);
    - regra que bateu no limite diário e parou sozinha;
    - lembrete de desligar no n8n a regra equivalente ao ativar.
- **Histórico por regra:** quem criou, mudou, ativou ou pausou, e quando.
- **Regra de negócio que a tela explica em uma linha:** se alguém da equipe já escreveu para o lead depois do clique, o painel não envia.

### 5.5 Jornada · Acompanhamento
Para que serve: ver se a jornada converte e onde ela perde lead.

- **Período de/até**, como no painel.
- **Funil da jornada:** lead criado → abertura enviada → clicou → "3 ou mais" ou "Eu e mais 1" → a SDR respondeu → agendou. Cada etapa mostra a quantidade, a % que passou para a próxima e o tempo da passagem.
- **Separado entre expediente e fora do expediente.** É o maior vazamento hoje: quem responde fora do expediente agenda 11%, contra 26% de quem responde dentro.
- **Tempos com meta:**
    - do cadastro até a abertura (hoje cerca de 4 min);
    - do clique até a SDR responder (meta de 5 min);
    - os cliques da noite até a SDR responder de manhã (hoje cerca de 1 h útil).
- **Por regra:** cliques, envios feitos, falhas com o motivo ("número sem WhatsApp", "erro da Meta 100"), pulados com o motivo ("a SDR já respondeu", "lead sem dono") e, depois do envio, quantos responderam e quantos agendaram.
- **Por SDR:** o mesmo funil lado a lado.
- **Linha de base para comparar:** setembro e outubro tiveram de 9% a 10% de agendamento sobre os leads novos sem DSQ, e 47% de resposta à abertura.

### 5.6 Alertas (proposta, a decidir)
Para que serve: mostrar na hora o que quebrou na operação. Hoje esses problemas só são descobertos dias depois.

Uma lista de alertas abertos, do mais grave para o mais leve. Cada alerta mostra: o que é, desde quando, quantos leads afeta, link para a lista dos leads e o botão **Resolver** (com quem resolveu e quando).

| Alerta | Caso real que motivou |
|---|---|
| A automação parou: leads novos sem abertura há mais de X min | Em 13/10, 79% dos leads novos ficaram sem template |
| Clique esperando a SDR há mais de X min | 10% dos cliques da noite nunca tiveram resposta de uma pessoa |
| Falha no envio de template (erro da Meta) | Erro 100 ao enviar o template |
| Regra da jornada pausada sozinha (limite diário) | Proteção nova da Fase 11 |
| Lead sem conversa no Poli | 102 leads em outubro, 39 do Calendly sem telefone |
| Lead que deveria estar em DSQ ("Sou Autônomo" na cadência) | 170 leads em outubro |
| Lead do Calendly sem link da reunião | Leads marcaram e não receberam o Meet |
| Reunião passada ainda como "agendada" | Reuniões de 09/10 continuavam abertas |
| Problema no Google: evento apagado, agenda desconectada | Já existe na fila "Com problema" das Reuniões e viria para cá |
| Reunião cancelada ou no show que não saiu da agenda do closer (o Google recusou mover para o arquivo) | Em 15/10, duas reuniões canceladas continuaram na agenda do Jerferson, porque faltava permissão dele na agenda de arquivo, e ninguém foi avisado |
| Lead que respondeu e foi descartado automaticamente aos 7 dias | 11 leads descartados como "Término de carteira" |

### 5.7 Prioridade da lista do SDR (futuro, só registrar)
O Felipe quer, depois, configurar no painel a ordem em que os leads aparecem para o SDR (por exemplo: cliques esperando primeiro, depois "3 ou mais", depois leads grandes). Não desenhar agora; só deixar espaço na navegação da Jornada.

## 6. Decisões ainda em aberto

- Confirmação de reunião: a mensagem precisa ser do próprio SDR ou vale qualquer pessoa da equipe?
- No show: como a Poli calcula os 15% históricos (inclui invalidadas?), para o painel usar a mesma conta.
- Alertas: só o gestor vê, ou a SDR vê os alertas dos leads dela (por exemplo, clique esperando)?
- Alertas: só na tela, ou também avisando por WhatsApp, e-mail ou notificação nos urgentes (automação parada, clique esperando)?
