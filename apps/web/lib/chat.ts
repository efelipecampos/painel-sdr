// Aviso no espaço "Gestão SDR" do Google Chat (mesmo webhook dos alertas da Fase 8; decisão de 2026-10-07).
export async function postGestaoSdr(text: string): Promise<boolean> {
  const url = process.env.GOOGLE_CHAT_WEBHOOK_URL_ALERTAS;
  if (!url) return false;
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json; charset=UTF-8" }, body: JSON.stringify({ text }) });
    return r.ok;
  } catch {
    return false;
  }
}
