import { env } from "../config/env.js";

/**
 * OpenAI para transcrever áudio e ler imagem das conversas — o texto
 * resultante vai pro Supabase (painel), não pro HubSpot.
 *
 * Os nomes de modelo ficam em env porque o catálogo da OpenAI muda com
 * frequência; o default é o mais barato que atende cada caso.
 */

const OPENAI_BASE_URL = "https://api.openai.com/v1";

export class OpenAiApiError extends Error {
  constructor(
    public readonly status: number,
    body: string,
  ) {
    super(`OpenAI API error ${status}: ${body.slice(0, 300)}`);
  }
}

export function isOpenAiConfigured(): boolean {
  return env.OPENAI_API_KEY !== "";
}

async function openAiFetch<T>(path: string, init: RequestInit): Promise<T> {
  const res = await fetch(`${OPENAI_BASE_URL}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, ...init.headers },
    signal: AbortSignal.timeout(env.OPENAI_TIMEOUT_MS),
  });
  if (!res.ok) throw new OpenAiApiError(res.status, await res.text().catch(() => ""));
  return (await res.json()) as T;
}

export async function transcribeAudio(audio: Blob, fileName: string): Promise<string> {
  const form = new FormData();
  form.append("file", audio, fileName);
  form.append("model", env.OPENAI_TRANSCRIPTION_MODEL);
  // Sem idioma fixo: há leads em espanhol (LATAM) além dos em português, e
  // forçar "pt" num áudio em espanhol piora ou traduz a transcrição. Dá pra
  // fixar via OPENAI_TRANSCRIPTION_LANGUAGE quando fizer sentido.
  if (env.OPENAI_TRANSCRIPTION_LANGUAGE) form.append("language", env.OPENAI_TRANSCRIPTION_LANGUAGE);

  const res = await openAiFetch<{ text?: string }>("/audio/transcriptions", { method: "POST", body: form });
  return (res.text ?? "").trim();
}

const IMAGE_PROMPT =
  "Descreva em português, em no máximo 3 frases, o que esta imagem mostra. " +
  "Se houver texto legível (print de conversa, comprovante, documento, cartão), transcreva o texto relevante. " +
  "Responda apenas com a descrição, sem preâmbulo.";

export async function describeImage(image: Buffer, mimeType: string): Promise<string> {
  const dataUrl = `data:${mimeType};base64,${image.toString("base64")}`;

  const res = await openAiFetch<{ choices?: Array<{ message?: { content?: string } }> }>("/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: env.OPENAI_VISION_MODEL,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: IMAGE_PROMPT },
            { type: "image_url", image_url: { url: dataUrl, detail: env.OPENAI_IMAGE_DETAIL } },
          ],
        },
      ],
      max_completion_tokens: 400,
    }),
  });

  return (res.choices?.[0]?.message?.content ?? "").trim();
}
