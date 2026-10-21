// Histórico de conversas das SDRs puxado da API do Poli (2026-10-21), só para análises: grava em
// painel.historico_*, que nenhuma tela lê. Aqui ficam as regras puras (testadas em regras.test.ts).
import { createHash } from "node:crypto";

/** Início do histórico: 01/11/2025 00:00 em São Paulo. */
export const CORTE = "2025-11-01T03:00:00.000Z";

/**
 * SDRs do período (Felipe, 2026-10-21): as 7 atuais do painel e as de novembro/2025 a janeiro/2026 que já saíram
 * ou mudaram de time. O contato entra quando esteve com uma delas em algum momento.
 */
export const SDRS_HISTORICO = [
  "Gabriela Mota", "Isadora Rocha", "Jessica Ferreira", "Julliana Reis", "Leticia Bezerra", "Matheus Sanches Dias",
  "Samuel Santos", "Igor Lopes", "Ingrid Ribeiro", "Erika Lustosa", "Isabela Sousa", "Bruno Subires",
  "Maria Eduarda Oliveira",
];

export function normalizar(nome: string | null | undefined): string {
  return (nome ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

export interface PoliMensagem {
  uuid: string;
  event?: string | null;
  type?: string | null;
  ack?: string | null;
  direction?: string | null;
  template?: { name?: string | null; key?: string | null } | null;
  author?: { type?: string | null; uuid?: string | null; attributes?: { name?: string | null } | null } | null;
  attendance?: { uuid?: string | null; attendant?: { uuid?: string | null; attributes?: { name?: string | null } | null } | null } | null;
  components?: { name?: string | null; body?: { text?: string | null } | null; buttons?: unknown[] | null } | null;
  metadata?: { created_at?: string | null; direction?: string | null } | null;
}

export interface LinhaMensagem {
  poli_message_uuid: string;
  poli_contact_uuid: string;
  poli_attendance_uuid: string | null;
  enviada_em: string;
  direcao: string | null;
  tipo: string | null;
  evento: string | null;
  autor_tipo: string | null;
  autor_uuid: string | null;
  autor_nome: string | null;
  atendente_uuid: string | null;
  atendente_nome: string | null;
  template_nome: string | null;
  texto: string | null;
  botoes: unknown[] | null;
  ack: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * Parte dos ids do Poli não é uuid (mensagens antigas, de sistema e de bot) e alguns trazem o telefone do contato
 * ("sys-0-11000-55119...-msg-..."). Esses viram um uuid tirado do hash do id: o mesmo id dá sempre o mesmo uuid
 * (a carga pode ser refeita) e o telefone não entra no banco.
 */
export function idPoli(id: string | null | undefined): string | null {
  if (!id) return null;
  if (UUID.test(id)) return id.toLowerCase();
  const h = createHash("md5").update(id).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

const direcao = (m: PoliMensagem) => m.direction ?? m.metadata?.direction ?? null;

/** Nomes de quem atendeu ou escreveu pelo lado da Poli (nunca o nome do contato). */
export function nomesDoLadoPoli(m: PoliMensagem): string[] {
  const nomes = [m.attendance?.attendant?.attributes?.name];
  if (direcao(m) !== "IN") nomes.push(m.author?.attributes?.name);
  return nomes.filter((n): n is string => !!n?.trim());
}

/**
 * A mensagem mostra que o contato esteve com uma SDR: a SDR é a dona do atendimento, escreveu a mensagem,
 * ou o aviso do sistema diz que o contato foi redirecionado para ela ("Contato redirecionado para X por Y").
 */
export function passouPorSdr(m: PoliMensagem, sdrs: Set<string>): boolean {
  if (nomesDoLadoPoli(m).some((n) => sdrs.has(normalizar(n)))) return true;
  if (direcao(m) !== "SYSTEM") return false;
  const texto = normalizar(m.components?.body?.text);
  return [...sdrs].some((s) => texto.includes(`para ${s}`));
}

export function paraLinha(m: PoliMensagem, contato: string): LinhaMensagem | null {
  const em = m.metadata?.created_at;
  if (!m.uuid || !em) return null;
  const dir = direcao(m);
  const botoes = m.components?.buttons;
  return {
    poli_message_uuid: idPoli(m.uuid)!,
    poli_contact_uuid: contato,
    poli_attendance_uuid: idPoli(m.attendance?.uuid),
    enviada_em: em,
    direcao: dir,
    tipo: m.type ?? null,
    evento: m.event ?? null,
    autor_tipo: m.author?.type ?? null,
    autor_uuid: idPoli(m.author?.uuid),
    // LGPD: o nome do autor só fica quando é do lado da Poli (atendente ou bot), nunca o do contato
    autor_nome: dir === "IN" ? null : m.author?.attributes?.name ?? null,
    atendente_uuid: idPoli(m.attendance?.attendant?.uuid),
    atendente_nome: m.attendance?.attendant?.attributes?.name ?? null,
    template_nome: m.template?.name ?? m.template?.key ?? m.components?.name ?? null,
    texto: m.components?.body?.text ?? null,
    botoes: Array.isArray(botoes) && botoes.length ? botoes : null,
    ack: m.ack ?? null,
  };
}
