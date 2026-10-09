# Fase 9 — SDR Modelo

Especificação em rascunho (2026-10-09). Os itens marcados **[decidir]** esperam o Felipe. Nada aqui vira código antes da aprovação.

## 1. Para que serve

Mostrar onde cada SDR precisa de treino. A aderência ao SDR Modelo é usada pelo gestor para achar o que treinar e é levada para o 1:1. Não é ranking nem bônus.

- O **SDR Ideal** é um conjunto de comportamentos. Cada um tem uma faixa ideal e um peso.
- A **aderência** do SDR é a nota ponderada, de 0 a 100, com o detalhe de cada comportamento: dentro ou fora da faixa, o valor dele, a faixa e exemplos de conversas.
- O **período** é escolhido na tela (de/até), como no painel principal.
- **Quem vê:** o SDR vê a própria aderência e o detalhe. Gestor e admin veem todos os SDRs e a visão do time. Gestor e admin editam o SDR Ideal.

## 2. Comportamentos

Os comportamentos são de dois tipos.

### 2.1 Números (calculados no banco, com as definições de `spec.md`)

| Comportamento | Medida | Origem |
|---|---|---|
| Volume | **[decidir]** proposta: leads abordados por dia útil do período | Leads abordados (`spec.md` §2) |
| 1ª resposta | Mediana do tempo de primeira resposta | `spec.md` §2 |
| Tempo de resposta | Mediana do tempo de resposta | `spec.md` §2 |
| Taxa de resposta | **[decidir]** proposta: leads que responderam ÷ leads abordados no período | Não existe hoje no painel; definição nova |
| Descartes | **[decidir]** proposta: descartados ÷ leads que responderam no período | Descartados (`spec.md` §2) |
| Reuniões validadas | **[decidir]** proposta: reuniões validadas ÷ leads que responderam, pela data da reunião | `painel.meetings` (agendamentos pelo painel desde 09/10/2026) |
| Confirmação de reunião | % das reuniões do SDR em que houve mensagem de confirmação **no dia** e mensagens **logo antes** da reunião (decisão do Felipe, 2026-10-09). **[decidir]** quanto é "logo antes" (proposta: até 60 min antes do início) e se a mensagem precisa ser do SDR ou vale de qualquer pessoa da equipe | `painel.meetings` + `painel.chat_messages` |

Comportamento novo do tipo número precisa de código, porque tem cálculo no banco.

### 2.2 Qualidade da conversa (avaliada pela IA)

A IA é a mesma do score (Celeris, `SCORE_IA`), com as conversas mascaradas.

| Comportamento | O que a IA olha |
|---|---|
| Perguntas | Qualidade das perguntas, objetividade, se as perguntas levam à qualificação |
| Gatilhos mentais | Uso de urgência, escassez, prova social, autoridade e dor. O detalhe mostra quais gatilhos aparecem |

- Os comportamentos de conversa ficam **editáveis na tela**: nome, descrição do que a IA deve olhar e se está ativo. Se o Felipe ou o Iago pensarem em outro, cadastram na tela, sem código.
- Mudou a descrição: as conversas avaliadas a partir dali usam a versão nova. A tela mostra a versão usada no período.

**Quais conversas a IA lê (decisão do Felipe, 2026-10-09):**
- Todas em que o lead respondeu.
- Cada conversa é avaliada uma vez, quando para de andar. **[decidir]** quanto tempo sem mensagem conta como "parou": proposta de 24 h.
- O resultado fica guardado por conversa, com a nota de cada comportamento e um trecho curto que justifica a nota.
- Trocar o período só junta o que já foi avaliado, então não gera custo.
- Antes de ligar, um teste com 20 conversas, com custo por dia e por mês, como no score.

## 3. SDR Ideal: faixas e pesos

- **Primeira versão:** sai dos dados dos melhores SDRs atuais (decisão do Felipe, 2026-10-09).
  - **[decidir]** quem são "os melhores". Proposta: os 3 com maior taxa de reuniões validadas nos últimos 30 dias.
  - **[decidir]** como sai a faixa. Proposta: do pior ao melhor valor entre esses 3.
- Gestor e admin editam faixas e pesos depois, por exemplo com estudos de mercado. Toda edição gera versão nova, com data e autor.
- **Sugestões da IA:** de tempos em tempos, a IA compara as conversas que viraram reunião validada com as outras e sugere ajustes de faixa ou de peso, com a justificativa.
  - O gestor aprova ou recusa. Nada muda sem aprovação.
  - **[decidir]** frequência. Proposta: uma vez por semana.

## 4. Telas

- **SDR Modelo, visão do time:** os comportamentos nas linhas e os SDRs nas colunas, com a aderência de cada um. Mostra onde o time inteiro está fora da faixa, que é onde o treino coletivo rende mais.
- **SDR Modelo, um SDR:** a aderência, cada comportamento com valor × faixa e exemplos de conversas (link para o chat). O SDR vê só a dele.
- **SDR Ideal (configuração):** faixas, pesos, comportamentos de conversa, histórico de versões e as sugestões da IA para aprovar.
- O desenho das telas vem antes do código, no padrão de `design/`.

## 5. Regras

- Métricas no banco (RPC). O front só exibe.
- Período com amostra pequena (proposta: menos de 10 conversas avaliadas ou menos de 3 reuniões) mostra "amostra pequena" no comportamento em vez de dentro/fora.
- LGPD: as conversas vão mascaradas para a IA. Os exemplos na tela levam ao chat, sem copiar telefone.
- Custo: limite de conversas por rodada e registro de tokens, como no score.
