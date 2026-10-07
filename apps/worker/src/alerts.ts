// Alertas de operação (Fase 8): o worker confere a saúde do painel e avisa no Google Chat (espaço Gestão SDR).
// Cada problema avisa uma vez quando começa e uma vez quando resolve.
// LGPD: as mensagens nunca levam conteúdo de mensagem, nome ou telefone de lead.
import type { SupabaseClient } from "@supabase/supabase-js";
import { config } from "./config.js";
import { getCursor } from "./processor.js";
import { AlertState, alertText, filaParada, poliMuda, type AlertKey } from "./alert-rules.js";

/** Devolve true se o Google Chat aceitou a mensagem. */
export async function postToGoogleChat(text: string): Promise<boolean> {
  if (!config.alertWebhookUrl) {
    console.warn("[alertas] GOOGLE_CHAT_WEBHOOK_URL_ALERTAS não configurada; alerta só no log:", text);
    return false;
  }
  const res = await fetch(config.alertWebhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) console.error(`[alertas] falha ao enviar para o Google Chat: HTTP ${res.status}`);
  return res.ok;
}

/** Mensagem de erro curta para o alerta (as mensagens de erro do worker não levam dados de lead). */
function short(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length > 200 ? msg.slice(0, 200) + "…" : msg;
}

/** Liga o estado dos alertas ao Google Chat e às consultas de saúde. */
export class Monitor {
  private state = new AlertState();
  private lastCheck = 0;
  private lastError = new Map<AlertKey, string>();

  constructor(private db: SupabaseClient, private now: () => number = Date.now) {}

  /** `minutos` substitui a duração no texto do problema (ex.: tempo em horário comercial). */
  private async report(key: AlertKey, ok: boolean, limiteMin: number, detalhe = "", minutos?: number): Promise<void> {
    const t = this.state.report(key, ok, this.now(), limiteMin);
    if (!t) return;
    if (t.kind === "problema" && minutos !== undefined) t.minutos = minutos;
    console.log(`[alertas] ${t.key}: ${t.kind}`);
    try {
      await postToGoogleChat(alertText(t, t.kind === "problema" ? detalhe : ""));
    } catch (err) {
      console.error("[alertas] falha ao enviar para o Google Chat:", short(err));
    }
  }

  /** Resultado de uma rodada de leitura de raw_events. */
  async worker(err: unknown | null): Promise<void> {
    if (err) this.lastError.set("worker", short(err));
    await this.report("worker", !err, config.alertWorkerMinutes, `Último erro: ${this.lastError.get("worker") ?? ""}`);
  }

  /** Resultado de uma tentativa de sync do HubSpot. */
  async hubspot(err: unknown | null): Promise<void> {
    if (err) this.lastError.set("hubspot", short(err));
    await this.report("hubspot", !err, config.alertHubspotMinutes, `Último erro: ${this.lastError.get("hubspot") ?? ""}`);
  }

  /** Verificações periódicas (fila, Poli, painel no ar). Roda no máximo a cada `alertCheckMinutes`. */
  async check(): Promise<void> {
    if (this.now() - this.lastCheck < config.alertCheckMinutes * 60_000) return;
    this.lastCheck = this.now();
    try {
      await this.checkFila();
      await this.checkPoli();
    } catch (err) {
      // Banco fora: o alerta do worker já cobre (a rodada de leitura também falha).
      console.error("[alertas] erro ao conferir a fila:", short(err));
    }
    await this.checkPainel();
  }

  private async checkFila(): Promise<void> {
    const cursor = await getCursor(this.db);
    const res = await this.db.from("raw_events").select("received_at").gt("id", cursor).order("id").limit(1);
    if (res.error) throw new Error(`ler raw_events pendentes: ${res.error.message}`);
    const oldest = res.data.length ? new Date(res.data[0].received_at as string) : null;
    await this.report("fila", !filaParada(oldest, new Date(this.now()), config.alertQueueMinutes), 0,
      oldest ? `Evento mais antigo esperando desde ${oldest.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}.` : "");
  }

  private async checkPoli(): Promise<void> {
    const last = await this.db.from("raw_events").select("received_at").order("id", { ascending: false }).limit(1);
    if (last.error) throw new Error(`ler último raw_event: ${last.error.message}`);
    if (!last.data.length) return;
    const secs = await this.db.schema("painel").rpc("business_seconds", {
      p_from: last.data[0].received_at, p_to: new Date(this.now()).toISOString(),
    });
    if (secs.error) throw new Error(`business_seconds: ${secs.error.message}`);
    const secsSince = secs.data as number;
    await this.report("poli", !poliMuda(secsSince, config.alertPoliMinutes), 0, "", Math.round(secsSince / 60));
  }

  private async checkPainel(): Promise<void> {
    let detalhe = "";
    let ok = false;
    try {
      const res = await fetch(config.painelUrl + "/login", { signal: AbortSignal.timeout(15_000), redirect: "manual" });
      ok = res.status < 500;
      detalhe = `${config.painelUrl}/login respondeu HTTP ${res.status}.`;
    } catch (err) {
      detalhe = `${config.painelUrl}/login não respondeu (${short(err)}).`;
    }
    await this.report("painel", ok, config.alertPainelMinutes, detalhe);
  }
}
