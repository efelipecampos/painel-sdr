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
   SDR (`POLI_SDR_EMAILS`) ou Closer (`POLI_CLOSER_EMAILS`).
4. Busca o Contact no HubSpot pelo telefone do lead.
   - **Encontrado**: cria uma Communication (`WHATS_APP`) associada ao
     contato e atualiza as propriedades `poli_ultima_mensagem_em`,
     `poli_direcao_ultima_mensagem`, `poli_aguardando_resposta`.
   - **Não encontrado**: envia alerta pro Google Chat, no espaço do papel
     de quem está atendendo (SDR ou Closer).
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
| `POLI_SDR_EMAILS` / `POLI_CLOSER_EMAILS` | Listas de e-mails do time de pré-vendas na Poli, por papel |
| `HUBSPOT_PRIVATE_APP_TOKEN` | Private App no HubSpot com escopo de escrita em `contacts` e `communications` |
| `GOOGLE_CHAT_WEBHOOK_URL_SDR` / `GOOGLE_CHAT_WEBHOOK_URL_CLOSER` | Webhooks de dois espaços do Google Chat, um por papel |

Depois de configurar o token do HubSpot, criar as propriedades customizadas
do Contact (uma vez só):

```bash
npm run setup:hubspot-properties
```

E apontar o webhook "todas as mensagens" da conta PoliChat para
`https://poli-hubspot.camposai.com.br/webhooks/poli` (a Poli hoje aponta esse
mesmo tipo de evento para `n8n.poli.digital` — é só trocar a URL de destino).

## Testes

```bash
npm test          # unit tests (telefone, filtro de equipe, parser do payload real, etc.)
npm run typecheck
```

## Deploy (VPS Hostinger)

A VPS já roda [Coolify](https://coolify.io), cujo Traefik (`coolify-proxy`)
cuida de TLS/roteamento por domínio pra tudo na máquina. O
`docker-compose.yml` deste projeto já vem com os labels do Traefik prontos —
não expõe porta nenhuma pro host, junta a rede `coolify` e pede certificado
Let's Encrypt pra `poli-hubspot.camposai.com.br` automaticamente.

1. Criar o registro DNS (uma vez só, no painel da Hostinger):
   `A poli-hubspot -> 76.13.112.74`
2. Copiar o projeto pra VPS (mesmo padrão usado no outro projeto que já roda
   lá, `/root/api4com-hubspot`):
   ```bash
   rsync -az --exclude node_modules --exclude .git --exclude data \
     ./ root@76.13.112.74:/root/poli-hubspot/
   ```
3. Na VPS, criar o `.env` (a partir do `.env.example`) e subir:
   ```bash
   ssh root@76.13.112.74
   cd /root/poli-hubspot
   docker compose up -d --build
   ```

O Traefik só emite o certificado Let's Encrypt depois que o DNS estiver
resolvendo — e a Poli só aceita cadastrar o webhook depois que o host
resolver e responder. Por isso a ordem importa: DNS → deploy → esperar
propagar/emitir o certificado → só então criar o webhook na Poli.
