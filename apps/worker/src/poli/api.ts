// Cliente da API do Poli (OmniAPI v3), usado pela jornada configurável (Fase 11, docs/jornada.md).
// Só o worker chama: o token de aplicação (POLI_API_TOKEN) nunca vai para o navegador.
// Erros carregam só o status HTTP e um motivo curto: nada de telefone nem texto de mensagem nos logs.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class PoliError extends Error {
  constructor(readonly op: string, readonly status: number, readonly reason: string) {
    super(`Poli ${op}: HTTP ${status} (${reason})`);
  }
}

export interface PoliTemplate {
  uuid: string;
  key: string;
  status: string | null;
  category: string | null;
  body: string;
  buttons: string[]; // só os botões de resposta, na ordem do template
}

export interface SendTemplate {
  templateUuid: string;
  channelUuid: string;
  /** Valores das variáveis do corpo, na ordem em que aparecem no texto. */
  bodyParams: string[];
}

type Fetch = typeof fetch;

export class PoliApi {
  constructor(private readonly baseUrl: string, private readonly token: string, private readonly f: Fetch = fetch) {}

  private async call<T>(op: string, path: string, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.f(this.baseUrl.replace(/\/$/, "") + path, {
        method: body ? "POST" : "GET",
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json", Accept: "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      if (!res.ok) throw new PoliError(op, res.status, await motivo(res));
      return (await res.json()) as T;
    }
  }

  /** Templates da conta, com o texto e os botões de resposta. */
  async listTemplates(accountUuid: string): Promise<PoliTemplate[]> {
    const out: PoliTemplate[] = [];
    for (let page = 1; page <= 200; page++) {
      const j = await this.call<{ data?: RawTemplate[]; meta?: { last_page?: number } }>(
        "listar_templates",
        `/accounts/${accountUuid}/templates?include=key,version,status,message,components,interactive,metadata&per_page=100&page=${page}`,
      );
      for (const t of j.data ?? []) out.push(toTemplate(t));
      if (!j.data?.length || !j.meta?.last_page || page >= j.meta.last_page) break;
    }
    return out;
  }

  /** Envia um template a um contato que já existe no Poli. Devolve o uuid da mensagem. */
  sendToContact(contactUuid: string, s: SendTemplate): Promise<string | null> {
    return this.send("enviar_template", `/contacts/${contactUuid}/messages`, s);
  }

  /** Envia um template a um telefone (modo teste). */
  sendToPhone(accountUuid: string, phone: string, s: SendTemplate): Promise<string | null> {
    return this.send("enviar_teste", `/accounts/${accountUuid}/contacts/${encodeURIComponent(phone)}/messages?include=contact`, s);
  }

  private async send(op: string, path: string, s: SendTemplate): Promise<string | null> {
    const j = await this.call<{ uuid?: string; data?: { uuid?: string } }>(op, path, {
      provider: "WHATSAPP",
      account_channel_uuid: s.channelUuid,
      type: "TEMPLATE",
      template_uuid: s.templateUuid,
      version: "v3",
      components: { body: { parameters: s.bodyParams.map((text) => ({ type: "text", text })) } },
    });
    return j.uuid ?? j.data?.uuid ?? null;
  }
}

interface RawTemplate {
  uuid: string;
  key?: string;
  status?: string;
  category?: string;
  message?: string | { body?: string; buttons?: { type?: string; text?: string }[] };
}

export function toTemplate(t: RawTemplate): PoliTemplate {
  const m = typeof t.message === "string" ? { body: t.message, buttons: [] } : (t.message ?? {});
  return {
    uuid: t.uuid,
    key: t.key ?? t.uuid,
    status: t.status ?? null,
    category: t.category ?? null,
    body: m.body ?? "",
    buttons: (m.buttons ?? []).filter((b) => b.type === "reply" && b.text).map((b) => b.text!.trim()),
  };
}

/** Motivo curto do erro, sem copiar o corpo inteiro (pode ter dado do contato). */
async function motivo(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { message?: string; error?: { code?: string | number; message?: string } };
    const m = String(j.error?.code ?? j.error?.message ?? j.message ?? "").replace(/\d{8,}/g, "#").slice(0, 120);
    return m || "sem_motivo";
  } catch {
    return "sem_motivo";
  }
}
