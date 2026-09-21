import { getAttendantRole } from "../config/team.js";
import { env } from "../config/env.js";
import type { MessageEvent } from "../poli/parser.js";
import { findContact } from "../hubspot/contacts.js";
import { createCommunication } from "../hubspot/communications.js";
import { buildPoliChatLink, updatePoliContactProperties } from "../hubspot/contactProperties.js";
import { fillMissingDealChatLinks, getOpenDealsForContact, type OpenDeal } from "../hubspot/deals.js";
import { getOwnerIdByEmail } from "../hubspot/owners.js";
import { sendLeadNotInHubSpotAlert } from "../alerts/googleChat.js";
import { recordDryRunResult } from "../queue/store.js";
import { logger } from "../logger.js";

export type ProcessResult =
  | { outcome: "skipped_not_presales" }
  | { outcome: "logged"; contactId: string; communicationId: string }
  | { outcome: "dry_run"; contactId: string | null }
  | { outcome: "alerted_contact_not_found" };

export async function processMessage(message: MessageEvent): Promise<ProcessResult> {
  const role = getAttendantRole(message.attendantEmail);
  if (!role) {
    logger.debug({ attendantEmail: message.attendantEmail }, "Mensagem fora do time de pré-vendas, ignorada");
    return { outcome: "skipped_not_presales" };
  }

  const match = await findContact({
    leadPhone: message.leadPhone,
    leadName: message.leadName,
    leadUuid: message.leadUuid,
    deprecatedContactId: message.deprecatedContactId,
  });
  const contactId = match?.contactId ?? null;

  if (env.DRY_RUN) {
    recordDryRunResult({
      externalMessageId: message.externalMessageId,
      direction: message.direction,
      leadName: message.leadName,
      leadPhone: message.leadPhone,
      leadUuid: message.leadUuid,
      messagePreview: message.text.slice(0, 200),
      attendantEmail: message.attendantEmail,
      contactId,
      isTemplate: message.isTemplate,
      templateName: message.templateName,
      matchedVia: match?.matchedVia,
    });
    logger.info(
      { leadPhone: message.leadPhone, contactId, matchedVia: match?.matchedVia, dryRun: true },
      "Dry run: mensagem avaliada, nada escrito no HubSpot",
    );
  }

  if (!contactId) {
    logger.info({ leadPhone: message.leadPhone, role }, "Contato não encontrado no HubSpot, enviando alerta");
    await sendLeadNotInHubSpotAlert(message, role);
    return env.DRY_RUN ? { outcome: "dry_run", contactId: null } : { outcome: "alerted_contact_not_found" };
  }

  if (env.DRY_RUN) {
    return { outcome: "dry_run", contactId };
  }

  const ownerId =
    message.direction === "OUT" && message.attendantEmail
      ? await getOwnerIdByEmail(message.attendantEmail)
      : undefined;

  // Falha em negócios não pode impedir o registro da mensagem em si — o
  // contato já garante a associação mínima.
  let openDeals: OpenDeal[] = [];
  try {
    openDeals = await getOpenDealsForContact(contactId);
  } catch (err) {
    logger.warn({ err, contactId }, "Falha ao buscar negócios abertos do contato, seguindo só com o Contact");
  }

  const communicationId = await createCommunication({
    contactId,
    dealIds: openDeals.map((d) => d.id),
    message,
    ownerId,
  });
  await updatePoliContactProperties(contactId, message);

  try {
    const filled = await fillMissingDealChatLinks(openDeals, buildPoliChatLink(message.leadUuid));
    if (filled.length > 0) logger.info({ contactId, dealIds: filled }, "Link do chat na Poli preenchido nos negócios");
  } catch (err) {
    logger.warn({ err, contactId }, "Falha ao preencher o link do chat na Poli nos negócios");
  }

  logger.info({ contactId, communicationId, direction: message.direction }, "Mensagem registrada no HubSpot");
  return { outcome: "logged", contactId, communicationId };
}
