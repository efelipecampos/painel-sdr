/**
 * Cria (idempotente) as propriedades customizadas do Contact usadas pela
 * integração. Rode manualmente uma vez, depois de aprovar o modelo de dados
 * do plano: `npm run setup:hubspot-properties`.
 */
import { hubspotFetch, HubSpotApiError } from "../src/hubspot/client.js";
import { logger } from "../src/logger.js";

const GROUP_NAME = "polichat_integration";

const properties = [
  {
    name: "poli_last_message_at",
    label: "Poli - última mensagem em",
    type: "datetime",
    fieldType: "date",
    groupName: GROUP_NAME,
  },
  {
    name: "poli_last_message_direction",
    label: "Poli - direção da última mensagem",
    type: "enumeration",
    fieldType: "select",
    groupName: GROUP_NAME,
    options: [
      { label: "Recebida (lead)", value: "RECEIVED", displayOrder: 0 },
      { label: "Enviada (time)", value: "SENT", displayOrder: 1 },
    ],
  },
  {
    name: "poli_awaiting_reply",
    label: "Poli - aguardando resposta do lead",
    type: "bool",
    fieldType: "booleancheckbox",
    groupName: GROUP_NAME,
  },
];

async function ensurePropertyGroup(): Promise<void> {
  try {
    await hubspotFetch("/crm/v3/properties/contacts/groups", {
      method: "POST",
      body: JSON.stringify({ name: GROUP_NAME, label: "Integração PoliChat" }),
    });
    logger.info("Grupo de propriedades criado");
  } catch (err) {
    if (err instanceof HubSpotApiError && err.status === 409) {
      logger.info("Grupo de propriedades já existe, seguindo");
      return;
    }
    throw err;
  }
}

async function ensureProperty(property: (typeof properties)[number]): Promise<void> {
  try {
    await hubspotFetch("/crm/v3/properties/contacts", {
      method: "POST",
      body: JSON.stringify(property),
    });
    logger.info({ property: property.name }, "Propriedade criada");
  } catch (err) {
    if (err instanceof HubSpotApiError && err.status === 409) {
      logger.info({ property: property.name }, "Propriedade já existe, seguindo");
      return;
    }
    throw err;
  }
}

async function main() {
  await ensurePropertyGroup();
  for (const property of properties) {
    await ensureProperty(property);
  }
  logger.info("Setup de propriedades do HubSpot concluído");
}

main().catch((err) => {
  logger.error({ err }, "Falha no setup de propriedades do HubSpot");
  process.exit(1);
});
