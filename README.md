# PoliChat → HubSpot

Serviço que escuta o webhook de mensagens da PoliChat, filtra as conversas do
time de pré-vendas (SDR/Closer) e registra cada mensagem no HubSpot associada
ao Contact correto — além de alertar no Google Chat quando o número não
existe como Contact. Fluxo unidirecional: **Poli → HubSpot**.

O plano completo (contexto de negócio, decisões de arquitetura, mapeamento de
campos do payload real da Poli) está em
`/Users/felipecampos/.claude/plans/bright-foraging-brooks.md`.

## Como funciona (resumo)

1. A Poli envia um webhook (`POST /webhooks/poli`) pra cada mensagem, em
   qualquer chat da conta.
2. O serviço valida a assinatura (`x-webhook-signature`), faz parse do
   payload e responde 2xx imediatamente.
3. Só segue adiante se `attendance.attendant.email` estiver na whitelist de
   SDR/Closer (`POLI_SDR_CLOSER_EMAILS`).
4. Busca o Contact no HubSpot pelo telefone do lead.
   - **Encontrado**: cria uma Communication (`WHATS_APP`) associada ao
     contato e atualiza as propriedades `poli_last_message_at`,
     `poli_last_message_direction`, `poli_awaiting_reply`.
   - **Não encontrado**: envia alerta pro Google Chat.
5. Falhas de escrita no HubSpot caem numa fila local (SQLite) com retry
   automático a cada 1 min — não é banco de analytics, só confiabilidade.

## Setup

```bash
npm install
cp .env.example .env   # preencher os valores pendentes (ver abaixo)
npm run dev             # roda local com hot reload (tsx)
```

### Itens pendentes antes de rodar em produção (Fase 0 do plano)

| Variável | Onde conseguir |
|---|---|
| `POLI_WEBHOOK_SIGNING_SECRET` | Painel da Poli, na configuração do webhook |
| `POLI_SDR_CLOSER_EMAILS` | Lista de e-mails do time de pré-vendas na Poli |
| `HUBSPOT_PRIVATE_APP_TOKEN` | Private App no HubSpot com escopo de escrita em `contacts` e `communications` |
| `GOOGLE_CHAT_WEBHOOK_URL` | Webhook de um espaço do Google Chat |

Depois de configurar o token do HubSpot, criar as propriedades customizadas
do Contact (uma vez só):

```bash
npm run setup:hubspot-properties
```

E apontar o webhook "todas as mensagens" da conta PoliChat para
`https://<seu-domínio>/webhooks/poli` (a Poli hoje aponta esse mesmo tipo de
evento para `n8n.poli.digital` — é só trocar a URL de destino).

## Testes

```bash
npm test          # unit tests (telefone, filtro de equipe, parser do payload real, etc.)
npm run typecheck
```

## Deploy (VPS Hostinger)

```bash
docker compose up -d --build
```

O `docker-compose.yml` expõe a porta 3000 diretamente — falta decidir/subir
um reverse proxy (Nginx/Caddy/Traefik) na VPS pra TLS, já que a Poli exige
HTTPS no webhook (item 5 da lista de pendências do plano).
