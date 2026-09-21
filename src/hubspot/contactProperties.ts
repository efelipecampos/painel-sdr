import { hubspotFetch } from "./client.js";
import type { MessageEvent } from "../poli/parser.js";

export function buildPoliChatLink(leadUuid: string): string {
  return `https://app.poli.digital/chat/${leadUuid}`;
}

/**
 * Atualiza as propriedades do Contact que dão visibilidade ao SDR dentro do
 * próprio HubSpot (fila "aguardando minha resposta" via
 * poli_aguardando_resposta). Ver seção "Modelo de dados no HubSpot" do
 * plano. Nomes internos e valores de enum em português, a pedido do
 * usuário, pra facilitar manutenção/integração futura por quem só lê
 * português.
 */
export async function updatePoliContactProperties(contactId: string, message: MessageEvent): Promise<void> {
  await hubspotFetch(`/crm/v3/objects/contacts/${contactId}`, {
    method: "PATCH",
    body: JSON.stringify({
      properties: {
        poli_ultima_mensagem_em: String(message.timestampMs),
        poli_direcao_ultima_mensagem: message.direction === "IN" ? "RECEBIDA" : "ENVIADA",
        poli_aguardando_resposta: message.direction === "IN" ? "true" : "false",
        // Backfill do ID/link da Poli sempre que resolvemos o contato (por
        // qualquer camada) — melhora a cobertura do Tier 0 (busca exata por
        // id) nas próximas mensagens desse mesmo lead.
        id_do_contato_na_poli: message.leadUuid,
        link_do_chat_na_poli: buildPoliChatLink(message.leadUuid),
      },
    }),
  });
}
