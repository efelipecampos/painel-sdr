import { isPreSalesAttendant } from "../config/team.js";
import type { MessageEvent } from "../poli/parser.js";
import { findContactIdByPhone } from "../hubspot/contacts.js";
import { createCommunication } from "../hubspot/communications.js";
import { updatePoliContactProperties } from "../hubspot/contactProperties.js";
import { getOwnerIdByEmail } from "../hubspot/owners.js";
import { sendLeadNotInHubSpotAlert } from "../alerts/googleChat.js";
import { logger } from "../logger.js";

export type ProcessResult =
  | { outcome: "skipped_not_presales" }
  | { outcome: "logged"; contactId: string; communicationId: string }
  | { outcome: "alerted_contact_not_found" };

export async function processMessage(message: MessageEvent): Promise<ProcessResult> {
  if (!isPreSalesAttendant(message.attendantEmail)) {
    logger.debug({ attendantEmail: message.attendantEmail }, "Mensagem fora do time de pré-vendas, ignorada");
    return { outcome: "skipped_not_presales" };
  }

  const contactId = await findContactIdByPhone(message.leadPhone);

  if (!contactId) {
    logger.info({ leadPhone: message.leadPhone }, "Contato não encontrado no HubSpot, enviando alerta");
    await sendLeadNotInHubSpotAlert(message);
    return { outcome: "alerted_contact_not_found" };
  }

  const ownerId =
    message.direction === "OUT" && message.attendantEmail
      ? await getOwnerIdByEmail(message.attendantEmail)
      : undefined;

  const communicationId = await createCommunication({ contactId, message, ownerId });
  await updatePoliContactProperties(contactId, message);

  logger.info({ contactId, communicationId, direction: message.direction }, "Mensagem registrada no HubSpot");
  return { outcome: "logged", contactId, communicationId };
}
