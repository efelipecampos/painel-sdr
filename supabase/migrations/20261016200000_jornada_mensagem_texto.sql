-- Jornada (2026-10-16, aprovado pelo Felipe): a regra pode enviar mensagem de texto em vez de template.
-- A jornada sempre responde a um clique, com a janela de 24 h do WhatsApp aberta: texto livre nessa janela não é
-- cobrado pela Meta, e template de Marketing é cobrado mesmo com a janela aberta. Texto não leva botão.
-- As regras que já existiam continuam como template.

alter table painel.journey_rules
  add column tipo text not null default 'template' check (tipo in ('template', 'texto')),
  add column texto text;

alter table painel.journey_rules alter column dest_template_uuid drop not null;

alter table painel.journey_rules add constraint journey_rules_envio_chk check (
  (tipo = 'template' and dest_template_uuid is not null)
  or (tipo = 'texto' and coalesce(btrim(texto), '') <> '')
);

-- journey_sends.dest_template_uuid guarda o que foi enviado, para a trava "uma vez por lead": o uuid do template ou,
-- para texto, 'texto:' + o md5 do texto (texto editado é envio novo).
comment on column painel.journey_sends.dest_template_uuid is 'template enviado, ou texto:<md5 do texto> quando a regra envia texto';
