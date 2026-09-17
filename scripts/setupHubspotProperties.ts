/**
 * Cria (idempotente) as propriedades customizadas usadas pela integração,
 * tanto no Contact quanto na Communication. Rode manualmente uma vez:
 * `npm run setup:hubspot-properties`.
 */
import { hubspotFetch, HubSpotApiError } from "../src/hubspot/client.js";
import { logger } from "../src/logger.js";

const GROUP_NAME = "polichat_integration";

const contactProperties = [
  {
    name: "poli_ultima_mensagem_em",
    label: "Poli - última mensagem em",
    type: "datetime",
    fieldType: "date",
    groupName: GROUP_NAME,
  },
  {
    name: "poli_direcao_ultima_mensagem",
    label: "Poli - direção da última mensagem",
    type: "enumeration",
    fieldType: "select",
    groupName: GROUP_NAME,
    options: [
      { label: "Recebida (lead)", value: "RECEBIDA", displayOrder: 0 },
      { label: "Enviada (time)", value: "ENVIADA", displayOrder: 1 },
    ],
  },
  {
    name: "poli_aguardando_resposta",
    label: "Poli - aguardando resposta do lead",
    type: "bool",
    fieldType: "booleancheckbox",
    groupName: GROUP_NAME,
    // HubSpot exige exatamente duas opções, com value 'true'/'false' fixos
    // (não dá pra traduzir o value) — só o label é traduzível.
    options: [
      { label: "Sim", value: "true", displayOrder: 0 },
      { label: "Não", value: "false", displayOrder: 1 },
    ],
  },
];

const communicationProperties = [
  {
    name: "poli_direcao",
    label: "Poli - direção",
    type: "enumeration",
    fieldType: "select",
    groupName: GROUP_NAME,
    options: [
      { label: "Enviada (time)", value: "ENVIADA", displayOrder: 0 },
      { label: "Recebida (lead)", value: "RECEBIDA", displayOrder: 1 },
    ],
  },
  {
    name: "poli_tipo_mensagem",
    label: "Poli - tipo de mensagem",
    type: "enumeration",
    fieldType: "select",
    groupName: GROUP_NAME,
    options: [
      { label: "Livre", value: "LIVRE", displayOrder: 0 },
      { label: "Template", value: "TEMPLATE", displayOrder: 1 },
    ],
  },
  {
    name: "poli_nome_template",
    label: "Poli - nome do template",
    type: "string",
    fieldType: "text",
    groupName: GROUP_NAME,
  },
];

async function ensurePropertyGroup(objectType: string): Promise<void> {
  try {
    await hubspotFetch(`/crm/v3/properties/${objectType}/groups`, {
      method: "POST",
      body: JSON.stringify({ name: GROUP_NAME, label: "Integração PoliChat" }),
    });
    logger.info({ objectType }, "Grupo de propriedades criado");
  } catch (err) {
    if (err instanceof HubSpotApiError && err.status === 409) {
      logger.info({ objectType }, "Grupo de propriedades já existe, seguindo");
      return;
    }
    throw err;
  }
}

async function ensureProperty(
  objectType: string,
  property: (typeof contactProperties)[number] | (typeof communicationProperties)[number],
): Promise<void> {
  try {
    await hubspotFetch(`/crm/v3/properties/${objectType}`, {
      method: "POST",
      body: JSON.stringify(property),
    });
    logger.info({ objectType, property: property.name }, "Propriedade criada");
  } catch (err) {
    if (err instanceof HubSpotApiError && err.status === 409) {
      logger.info({ objectType, property: property.name }, "Propriedade já existe, seguindo");
      return;
    }
    throw err;
  }
}

async function main() {
  for (const objectType of ["contacts", "communications"]) {
    await ensurePropertyGroup(objectType);
  }
  for (const property of contactProperties) {
    await ensureProperty("contacts", property);
  }
  for (const property of communicationProperties) {
    await ensureProperty("communications", property);
  }
  logger.info("Setup de propriedades do HubSpot concluído");
}

main().catch((err) => {
  logger.error({ err }, "Falha no setup de propriedades do HubSpot");
  process.exit(1);
});
