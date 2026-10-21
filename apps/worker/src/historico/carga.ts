// Carga do histórico de conversas das SDRs (2026-10-21). Uso:
//   npm run historico -- --paginas 3   (teste: só as 3 primeiras páginas de contatos, ~300 contatos mais novos)
//   npm run historico                  (tudo desde 01/11/2025; retoma de onde parou)
// Etapa 1: lista os contatos do Poli criados desde o corte (mais novos primeiro) em painel.historico_contatos.
// Etapa 2: para cada contato pendente, lê as mensagens; se passou por SDR, grava em painel.historico_mensagens.
// O log só tem contagens: nada de texto de mensagem, nome ou telefone (LGPD).
import { config } from "../config.js";
import { createDb } from "../processor.js";
import { CORTE, normalizar, nomesDoLadoPoli, paraLinha, passouPorSdr, SDRS_HISTORICO, type PoliMensagem } from "./regras.js";

const poli = config.poli;
if (!poli) throw new Error("POLI_API_BASE_URL e POLI_API_TOKEN são obrigatórios");
const db = createDb().schema("painel");
const arg = (n: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
const maxPaginas = arg("--paginas") ? Number(arg("--paginas")) : Infinity;
const PARALELO = Number(arg("--paralelo") ?? 4);
const sdrs = new Set(SDRS_HISTORICO.map(normalizar));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let chamadas = 0;
/** GET na API do Poli respeitando o limite da conta (x-ratelimit-remaining) e repetindo erros passageiros. */
async function get<T>(path: string): Promise<T> {
  for (let tentativa = 0; ; tentativa++) {
    const res = await fetch(poli!.baseUrl.replace(/\/$/, "") + path, { headers: { Authorization: `Bearer ${poli!.token}`, Accept: "application/json" } })
      .catch(() => null);
    chamadas++;
    const resta = Number(res?.headers.get("x-ratelimit-remaining") ?? 1000);
    if (resta < 200) { console.log(`[historico] limite do Poli perto do fim (${resta}); esperando 5 min`); await sleep(5 * 60_000); }
    if (res?.ok) return (await res.json()) as T;
    const status = res?.status ?? 0;
    if ((status === 0 || status === 429 || status >= 500) && tentativa < 6) {
      const espera = Number(res?.headers.get("retry-after") ?? 0) * 1000 || Math.min(60_000, 2000 * 2 ** tentativa);
      await sleep(espera);
      continue;
    }
    throw new Error(`Poli ${status} em ${path.split("?")[0]}`);
  }
}

async function estado(chave: string): Promise<any> {
  const { data } = await db.from("historico_carga").select("valor").eq("chave", chave).maybeSingle();
  return data?.valor ?? null;
}
async function salvar(chave: string, valor: unknown): Promise<void> {
  const { error } = await db.from("historico_carga").upsert({ chave, valor, atualizado_em: new Date().toISOString() });
  if (error) throw new Error(`historico_carga: ${error.message}`);
}

/** Etapa 1: contatos criados desde o corte. Contatos novos que chegam durante a carga só repetem linhas (upsert). */
async function listarContatos(): Promise<void> {
  const feito = await estado("contatos");
  if (feito?.fim) return console.log(`[historico] contatos já listados (${feito.pagina} páginas)`);
  let pagina = (feito?.pagina ?? 0) + 1;
  for (let lidas = 0; lidas < maxPaginas; pagina++, lidas++) {
    const r = await get<{ data: { uuid: string; metadata?: { created_at?: string } }[] }>(
      `/accounts/${poli!.accountUuid}/contacts?include=metadata&order=-created_at&per_page=100&page=${pagina}`);
    const dentro = r.data.filter((c) => c.metadata?.created_at && c.metadata.created_at >= CORTE);
    if (dentro.length) {
      const { error } = await db.from("historico_contatos").upsert(
        dentro.map((c) => ({ poli_contact_uuid: c.uuid, criado_no_poli: c.metadata!.created_at })), { onConflict: "poli_contact_uuid", ignoreDuplicates: true });
      if (error) throw new Error(`historico_contatos: ${error.message}`);
    }
    const fim = dentro.length < r.data.length || r.data.length === 0;
    await salvar("contatos", { pagina, fim, ultimo: r.data.at(-1)?.metadata?.created_at ?? null });
    if (pagina % 50 === 0) console.log(`[historico] contatos: página ${pagina}, criados até ${r.data.at(-1)?.metadata?.created_at?.slice(0, 10)}`);
    if (fim) return console.log(`[historico] contatos listados: ${pagina} páginas`);
  }
}

/** Etapa 2: mensagens de um contato desde o corte; grava só se passou por SDR. */
async function conferirContato(contato: string): Promise<"com_sdr" | "sem_sdr"> {
  const msgs: PoliMensagem[] = [];
  for (let pagina = 1; ; pagina++) {
    const r = await get<{ data: PoliMensagem[]; meta?: { next_page_url?: string | null } }>(
      `/contacts/${contato}/messages?include=preview,context,components,metadata,author,attendance,template&order=-created_at&per_page=100&page=${pagina}`);
    msgs.push(...r.data);
    const maisVelha = r.data.at(-1)?.metadata?.created_at;
    if (!r.meta?.next_page_url || !r.data.length || (maisVelha && maisVelha < CORTE)) break;
  }
  const doPeriodo = msgs.filter((m) => (m.metadata?.created_at ?? "") >= CORTE);
  const atendentes = [...new Set(doPeriodo.flatMap(nomesDoLadoPoli))].sort();
  const comSdr = doPeriodo.some((m) => passouPorSdr(m, sdrs));
  if (comSdr) {
    const linhas = doPeriodo.map((m) => paraLinha(m, contato)).filter((l) => l !== null);
    for (let i = 0; i < linhas.length; i += 500) {
      const { error } = await db.from("historico_mensagens").upsert(linhas.slice(i, i + 500), { onConflict: "poli_message_uuid" });
      if (error) throw new Error(`historico_mensagens: ${error.message}`);
    }
    await marcar(contato, { situacao: "com_sdr", atendentes, mensagens: linhas.length });
  } else {
    await marcar(contato, { situacao: "sem_sdr", atendentes, mensagens: 0 });
  }
  return comSdr ? "com_sdr" : "sem_sdr";
}

async function marcar(contato: string, campos: Record<string, unknown>): Promise<void> {
  const { error } = await db.from("historico_contatos").update({ ...campos, conferido_em: new Date().toISOString(), erro: null }).eq("poli_contact_uuid", contato);
  if (error) throw new Error(`historico_contatos: ${error.message}`);
}

async function conferirPendentes(): Promise<void> {
  const conta = { com_sdr: 0, sem_sdr: 0, erro: 0 };
  const inicio = Date.now();
  for (;;) {
    const { data, error } = await db.from("historico_contatos").select("poli_contact_uuid").eq("situacao", "pendente")
      .order("criado_no_poli", { ascending: false }).limit(PARALELO * 25);
    if (error) throw new Error(`historico_contatos: ${error.message}`);
    if (!data.length) break;
    const fila = data.map((d) => d.poli_contact_uuid as string);
    await Promise.all(Array.from({ length: PARALELO }, async () => {
      for (let c = fila.shift(); c; c = fila.shift()) {
        try {
          conta[await conferirContato(c)]++;
        } catch (err) {
          conta.erro++;
          // sem valores entre aspas: a mensagem do banco repete o dado recusado (que pode ter telefone)
          const erro = (err instanceof Error ? err.message : String(err)).replace(/"[^"]*"/g, '"…"').slice(0, 300);
          await db.from("historico_contatos").update({ situacao: "erro", erro, conferido_em: new Date().toISOString() }).eq("poli_contact_uuid", c);
        }
      }
    }));
    const min = (Date.now() - inicio) / 60_000;
    console.log(`[historico] ${conta.com_sdr} com SDR, ${conta.sem_sdr} sem SDR, ${conta.erro} com erro · ${chamadas} chamadas em ${min.toFixed(1)} min`);
  }
}

await listarContatos();
await conferirPendentes();
console.log(`[historico] fim: ${chamadas} chamadas ao Poli`);
process.exit(0);
