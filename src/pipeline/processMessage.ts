import { getAttendantRole } from "../config/team.js";
import { env } from "../config/env.js";
import type { MessageEvent } from "../poli/parser.js";
import { findContact } from "../hubspot/contacts.js";
import { createCommunication } from "../hubspot/communications.js";
import { buildPoliChatLink, updatePoliContactProperties } from "../hubspot/contactProperties.js";
import { fillMissingDealChatLinks, getOpenDealsForContact, writeCycleToDeals, type OpenDeal } from "../hubspot/deals.js";
import { getOwnerIdByEmail } from "../hubspot/owners.js";
import { sendLeadNotInHubSpotAlert } from "../alerts/googleChat.js";
import { recordDryRunResult } from "../queue/store.js";
import { isSupabaseConfigured } from "../supabase/client.js";
import { buildMessageRow, upsertMessages } from "../supabase/messages.js";
import { extractMediaText, mergeText, pickMediaTarget, shouldExtractMediaFor } from "../media/mediaText.js";
import { recordMediaTextFailure, clearMediaTextJob } from "../queue/store.js";
import { logger } from "../logger.js";

export type ProcessResult =
  | { outcome: "skipped_not_presales" }
  | { outcome: "logged"; contactId: string; communicationId: string; dealIds: string[] }
  | { outcome: "dry_run"; contactId: string | null }
  | { outcome: "alerted_contact_not_found" };

export async function processMessage(message: MessageEvent): Promise<ProcessResult> {
  const result = await handleMessage(message);

  // Espelha TODA mensagem no Supabase (inclusive fora da pré-venda) pro
  // painel de análise. Falha aqui não pode derrubar o fluxo do HubSpot, que
  // é o que o time usa no dia a dia.
  if (isSupabaseConfigured()) {
    // Áudio e imagem viram texto (OpenAI) só aqui, pro painel — o registro no
    // HubSpot continua com rótulo e link. Falha não impede a gravação da
    // mensagem: ela entra sem texto e o retry atualiza a linha depois.
    let text = message.text;
    // Só mídia de chat da pré-venda vai pra OpenAI. O espelho em `messages`
    // pega todos os times (suporte, CS), e transcrever tudo seria pagar por
    // conversa que o painel não analisa.
    const target = shouldExtractMediaFor(getAttendantRole(message.attendantEmail))
      ? pickMediaTarget(message.attachments)
      : undefined;
    if (target) {
      try {
        text = mergeText(message.text, await extractMediaText(target));
        clearMediaTextJob(message.externalMessageId);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        recordMediaTextFailure(message.externalMessageId, target, message.text, errorMessage);
        logger.warn({ err, id: message.externalMessageId, kind: target.kind }, "Texto da mídia falhou, enfileirado pra retry");
      }
    }

    try {
      await upsertMessages([
        buildMessageRow({ ...message, text }, {
          outcome: result.outcome,
          contactId: "contactId" in result ? result.contactId : null,
          communicationId: "communicationId" in result ? result.communicationId : null,
          dealIds: "dealIds" in result ? result.dealIds : undefined,
        }),
      ]);
    } catch (err) {
      logger.warn({ err, id: message.externalMessageId }, "Falha ao espelhar a mensagem no Supabase");
    }
  }

  return result;
}

async function handleMessage(message: MessageEvent): Promise<ProcessResult> {
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
  if (env.HUBSPOT_FIELDS_ENABLED) {
    const completedCycle = await updatePoliContactProperties(contactId, message);
    if (completedCycle) {
      logger.info(
        { contactId, horas: completedCycle.hours, template: completedCycle.templateName },
        "Lead respondeu a prospecção",
      );
      try {
        await writeCycleToDeals(openDeals, completedCycle);
      } catch (err) {
        logger.warn({ err, contactId }, "Falha ao copiar o ciclo de prospecção pros negócios");
      }
    }

    try {
      const filled = await fillMissingDealChatLinks(openDeals, buildPoliChatLink(message.leadUuid));
      if (filled.length > 0) logger.info({ contactId, dealIds: filled }, "Link do chat na Poli preenchido nos negócios");
    } catch (err) {
      logger.warn({ err, contactId }, "Falha ao preencher o link do chat na Poli nos negócios");
    }
  }

  logger.info({ contactId, communicationId, direction: message.direction }, "Mensagem registrada no HubSpot");
  return { outcome: "logged", contactId, communicationId, dealIds: openDeals.map((d) => d.id) };
}
