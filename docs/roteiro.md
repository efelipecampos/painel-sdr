# Roteiro — do zero ao painel no ar

Uma fase por vez. Cada fase termina com algo que funciona e foi testado. Só passe para a próxima quando a anterior estiver no ar.

## Fase 0 — O que o Felipe prepara (fora do Claude Code)

| Item | Onde | O que guardar |
|---|---|---|
| Projeto Supabase | supabase.com → New project, região São Paulo | URL, anon key, service_role key, senha do banco |
| Repositório | GitHub, privado, `painel-sdr` | URL do repositório |
| Acesso à VPS | Painel da Hostinger | IP, usuário, acesso SSH por chave |
| Domínio | Painel de DNS do domínio | Criar registro `A` do subdomínio do painel (ex.: `painel.camposai.com.br`) apontando para o IP da VPS |
| Poli | Time de produto/tech da Poli | Documentação da API e token da API (o webhook já chega na integração, não precisa cadastrar outro) |
| Supabase | Já criado: `pabbgxaphooftdsdewmq` | É o banco único do painel e da integração. |
| HubSpot | Configurações → Integrações → Aplicativos privados | Token do app privado |
| Anthropic | console.anthropic.com | Chave de API, com limite de gasto mensal configurado |

## Fase 1 — Projeto e banco

**Resultado:** repositório estruturado e schema `painel` aplicado no Supabase.

Prompt:

> Leia o CLAUDE.md, docs/spec.md e docs/roteiro.md. Vamos executar só a Fase 1. A Fase 0 está pronta e as chaves estão no .env.
>
> Regras desta fase:
> - Trabalhe no branch `fase-1` e só faça merge na main depois da minha aprovação. O repositório NÃO está ligado ao Supabase pelo GitHub: as migrations são aplicadas por você com o Supabase CLI (`supabase db push`), e só depois que eu aprovar o SQL.
> - O projeto Supabase tem "Automatically expose new tables" desligado e "automatic RLS" ligado. Nas migrations, inclua GRANTs explícitos para `authenticated` só nas funções RPC e tabelas que a tela precisa, e nada para `anon`.
> - A primeira migration cria `public.messages` e `public.raw_events` com o SQL exato de docs/integracao-mudancas.md (seção Tabelas), incluindo os GRANTs para `service_role`. Leia também `/Users/felipecampos/Desktop/PoliChat-Hubspot/supabase/schema.sql` e confira que `public.messages` ficou idêntica. O resto do projeto fica no schema `painel`.
> - Não aplique nada no banco sem me mostrar o SQL antes.
>
> Antes de escrever código, me mostre o plano: estrutura de pastas (monorepo com `apps/web`, `apps/worker`, `packages/shared`, `supabase/`), dependências e lista de migrations. Depois que eu aprovar: crie a estrutura, configure o Supabase CLI ligado ao meu projeto, transforme o schema da seção 3 em migrations com RLS, GRANTs e índices, e escreva a função `business_seconds` com testes cobrindo: intervalo dentro do expediente, atravessando a noite, atravessando o fim de semana, feriado, e intervalo todo fora do expediente. Crie o `.env.example`.

## Fase 2 — Evento cru na integração (no repositório PoliChat-Hubspot)

**Resultado:** a integração grava cada evento da Poli em `public.raw_events`, sem mudar nada do que ela já faz.

Pré-requisito: a Fase 1 aplicada (as tabelas `public.messages` e `public.raw_events` já existem no Supabase).

Esta fase é feita numa sessão do Claude Code aberta na pasta `PoliChat-Hubspot`, não no painel. O prompt está em `docs/integracao-mudancas.md`. Leia ali o aviso sobre `DAILY_NOTES_ENABLED` antes de subir.

Motivo de vir cedo: o painel só tem dado completo (ID do atendimento, tipo de autor, transferências, encerramentos) a partir do dia em que essa gravação começar. Depois de subir, deixe rodando 1 a 2 dias e siga.

Conferência: no Supabase, `select event_type, count(*) from public.raw_events group by 1;` deve mostrar eventos chegando, e o HubSpot deve continuar recebendo as mensagens normalmente.

## Fase 3 — Parser e backfill

**Resultado:** mensagens, chats, leads e SDRs normalizados; histórico importado pela API.

Prompt:

> Fase 3. Leia 30 exemplos reais de `public.raw_events` de cada `event_type` (me mostre os tipos de evento, os valores de `attendance.status`, `author.type` e os eventos SYSTEM encontrados antes de decidir o mapeamento). Use como ponto de partida o parser e o schema zod da integração (`PoliChat-Hubspot/src/poli/types.ts` e `parser.ts`). Com base nisso e na documentação da API da Poli em [LINK/ARQUIVO], proponha o mapeamento: template, bot, mensagem do SDR, mensagem do lead, atendente responsável, transferência, abertura e fechamento de chat. Depois de eu aprovar, crie o worker que processa raw_events de forma idempotente, gera response_events (regra de bloco da seção 2) e tem testes com sequências de mensagens reais anonimizadas. Crie também o script de backfill pela API a partir de [DATA].

## Fase 4 — Métricas no banco

**Resultado:** as funções RPC retornam os números certos.

Prompt:

> Fase 4. Crie as funções `sdr_metrics`, `team_metrics` e `sdr_chats` da seção 3. Para validar, escolha 3 chats reais do banco e me mostre, passo a passo, como cada métrica foi calculada para eles, para eu conferir com o que vejo no Poli.

Confira os números com o Poli antes de seguir. Se as definições estiverem erradas, é mais barato corrigir aqui.

## Fase 5 — Telas e login

**Resultado:** painel funcionando com dados reais, com login.

Prompt:

> Fase 5. Construa as telas `/login`, `/`, `/sdr/[id]` e `/configuracoes` reproduzindo os arquivos da pasta design/ (layout, cores de tokens.json, fonte Rubik). Os dados vêm das RPCs com a sessão do usuário (RLS), nunca com service_role no navegador. Configure o Supabase Auth só por convite e crie meu usuário como admin. Suba na VPS seguindo a seção 8 do spec: a VPS roda Coolify, então use labels do Traefik na rede `coolify` como o `docker-compose.yml` da integração PoliChat-Hubspot, sem Caddy e sem publicar portas.

## Fase 6 — HubSpot

**Resultado:** reuniões do HubSpot aparecem sozinhas na tabela de chats.

Prompt:

> Fase 6. Implemente o sync de reuniões do HubSpot da seção 5 no worker, com as regras de conflito e o histórico. Antes, liste os escopos necessários do app privado conforme a documentação atual do HubSpot, para eu configurar.

## Fase 7 — Score de qualidade

**Resultado:** score de hora em hora, configurável na tela.

Prompt:

> Fase 7. Implemente o job de score da seção 6. Primeiro rode em modo teste com 20 leads e me mostre as notas, as justificativas e o custo estimado por rodada e por mês antes de ligar o agendamento.

## Fase 8 — Operação

**Resultado:** o painel se mantém sozinho.

Prompt:

> Fase 8. Adicione: conferência diária com a API da Poli (seção 4, passo 6), alerta de fila parada, backup e instruções de deploy de atualização. Revise segurança: RLS de todas as tabelas, segredos, cabeçalhos HTTP e rate limit no webhook.
