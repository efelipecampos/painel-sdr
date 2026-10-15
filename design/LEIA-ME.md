# Referências de design

- `Main.dc.html`: painel principal (cards por SDR).
- `SDR.dc.html`: tabela de chats de um SDR, com status de reunião.
- `Configuracoes.dc.html`: configurações do painel.
- `SDRModeloTime.dc.html`, `SDRModeloUm.dc.html`, `SDRIdeal.dc.html`: Fase 9, SDR Modelo (visão do time, um SDR, configuração do SDR Ideal).
- `JornadaRegras.dc.html`, `JornadaAcompanhamento.dc.html`: Fase 11, jornada configurável (`docs/jornada.md`).
- `Alertas.dc.html`: tela de alertas (proposta; ver `briefing-claude-design.md`, seção 5.6).
- `tokens.json`: cores, tipografia, espaçamentos e raios do design system da Poli (tema escuro).

Os arquivos `.dc.html` são protótipos: o HTML dentro de `<x-dc>` é o layout; o `<script>` no fim traz dados de exemplo e o comportamento dos filtros. Use-os como referência visual e de comportamento, não como código de produção.
O logo aparece como `/_blob/...`: substitua pelo arquivo oficial da Poli.
