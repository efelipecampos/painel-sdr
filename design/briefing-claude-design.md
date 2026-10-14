# Painel SDR: briefing para o Claude Design

Atualizado em 14/10/2026. Junte este arquivo ao projeto no Claude Design com `tokens.json` e os protótipos `*.dc.html` desta pasta. Os protótipos foram o ponto de partida; este briefing diz o que mudou desde eles e o que falta desenhar.

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
| Gestor | Painel · Reuniões · Agendar · Carrosséis · Relatório · Configurações | Acompanhar o time, corrigir reuniões, ajustar regras |
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

## 6. Decisões ainda em aberto

- Confirmação de reunião: a mensagem precisa ser do próprio SDR ou vale qualquer pessoa da equipe?
- No show: como a Poli calcula os 15% históricos (inclui invalidadas?), para o painel usar a mesma conta.
