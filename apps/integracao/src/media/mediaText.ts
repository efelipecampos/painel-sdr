import { env } from "../config/env.js";
import { describeImage, isOpenAiConfigured, transcribeAudio } from "../openai/client.js";
import type { AttendantRole } from "../config/team.js";
import type { MediaAttachment } from "../poli/parser.js";
import { logger } from "../logger.js";

/**
 * Transforma áudio e imagem em texto (OpenAI) pra gravar no Supabase. O
 * HubSpot continua como está: lá a mensagem segue com rótulo e link.
 *
 * Figurinha e documento ficam de fora por decisão do usuário (2026-09-30).
 */

const AUDIO_TYPES = new Set(["AUDIO", "PTT", "VOICE"]);
const IMAGE_TYPES = new Set(["IMAGE", "PHOTO"]);

export type MediaKind = "audio" | "image";

export interface MediaTarget {
  kind: MediaKind;
  url: string;
  mimeType: string;
  fileName: string;
}

function kindOf(attachment: MediaAttachment): MediaKind | undefined {
  const type = (attachment.type ?? "").toUpperCase();
  const mime = (attachment.mimeType ?? "").toLowerCase();
  if (AUDIO_TYPES.has(type) || mime.startsWith("audio/")) return "audio";
  // Figurinha é imagem tecnicamente, mas não tem conteúdo útil pra análise.
  if (type === "STICKER") return undefined;
  if (IMAGE_TYPES.has(type) || mime.startsWith("image/")) return "image";
  return undefined;
}

/** Primeiro anexo que vale processar (áudio tem prioridade sobre imagem). */
export function pickMediaTarget(attachments: MediaAttachment[]): MediaTarget | undefined {
  const candidates = attachments
    .map((a) => ({ attachment: a, kind: kindOf(a) }))
    .filter((c): c is { attachment: MediaAttachment; kind: MediaKind } => c.kind !== undefined && !!c.attachment.url);

  const chosen = candidates.find((c) => c.kind === "audio") ?? candidates[0];
  if (!chosen) return undefined;

  const url = chosen.attachment.url as string;
  return {
    kind: chosen.kind,
    url,
    mimeType: chosen.attachment.mimeType ?? (chosen.kind === "audio" ? "audio/ogg" : "image/jpeg"),
    fileName: chosen.attachment.fileName ?? url.split("/").pop() ?? (chosen.kind === "audio" ? "audio.ogg" : "image.jpg"),
  };
}

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(env.MEDIA_DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Download da mídia falhou: HTTP ${res.status}`);

  const buffer = Buffer.from(await res.arrayBuffer());
  const maxBytes = env.MEDIA_MAX_MB * 1024 * 1024;
  if (buffer.byteLength > maxBytes) {
    throw new Error(`Mídia de ${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB acima do limite de ${env.MEDIA_MAX_MB} MB`);
  }
  return buffer;
}

/**
 * Baixa a mídia e devolve o texto (transcrição ou leitura da imagem).
 * Lança em caso de falha — quem chama decide entre seguir sem texto e
 * enfileirar pra nova tentativa.
 */
export async function extractMediaText(target: MediaTarget): Promise<string> {
  const buffer = await download(target.url);

  if (target.kind === "audio") {
    const blob = new Blob([new Uint8Array(buffer)], { type: target.mimeType.split(";")[0] });
    return transcribeAudio(blob, target.fileName);
  }
  return describeImage(buffer, target.mimeType.split(";")[0] ?? "image/jpeg");
}

export function isMediaUnderstandingEnabled(): boolean {
  return env.MEDIA_UNDERSTANDING_ENABLED && isOpenAiConfigured();
}

const mediaRoles = new Set(
  env.MEDIA_OPENAI_ROLES.split(",")
    .map((role) => role.trim().toUpperCase())
    .filter(Boolean),
);

/**
 * Mídia de quem vai pra OpenAI. Lista vazia = todo mundo; hoje só SDR, pra
 * não pagar por áudio de chat que o painel não analisa.
 */
export function shouldExtractMediaFor(role: AttendantRole | null): boolean {
  if (!isMediaUnderstandingEnabled()) return false;
  if (mediaRoles.size === 0) return true;
  return role !== null && mediaRoles.has(role);
}

/**
 * Junta o texto que veio na mensagem (legenda) com o texto extraído da
 * mídia, sem duplicar quando são iguais.
 */
export function mergeText(original: string, extracted: string | undefined): string {
  if (!extracted) return original;
  if (!original) return extracted;
  if (original.trim() === extracted.trim()) return original;
  return `${original}\n\n${extracted}`;
}

export async function extractMediaTextSafely(target: MediaTarget): Promise<string | undefined> {
  try {
    return await extractMediaText(target);
  } catch (err) {
    logger.warn({ err, kind: target.kind }, "Falha ao extrair texto da mídia");
    return undefined;
  }
}
