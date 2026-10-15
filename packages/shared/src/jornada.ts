// Jornada configurável (Fase 11, docs/jornada.md): regras puras usadas pelo worker (envio) e pela tela de regras
// (prévia e trava de ativação). Sem banco e sem rede: tudo aqui tem teste em jornada.test.ts.

export type Janela = "expediente" | "fora" | "sempre";
export type RegraStatus = "teste" | "ativa" | "pausada";

export interface Regra {
  id: string;
  origin_template_uuid: string;
  origin_button: string;
  janela: Janela;
  dest_template_uuid: string;
  status: RegraStatus;
  daily_limit: number | null;
}

/** Compara textos de botão sem diferença de maiúsculas, acentos de espaço e espaços nas pontas. */
export function normalizar(t: string): string {
  return t.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
}

/** O lead clicou num botão? Devolve o botão como está no template, ou null se a mensagem é texto livre. */
export function botaoClicado(mensagem: string | null | undefined, botoes: string[]): string | null {
  if (!mensagem) return null;
  const m = normalizar(mensagem);
  return botoes.find((b) => normalizar(b) === m) ?? null;
}

/**
 * Regra que vale para o clique: mesmo template de origem e mesmo botão, fora as pausadas.
 * Uma regra do horário exato (expediente ou fora) vence uma regra de "sempre".
 */
export function escolherRegra(regras: Regra[], templateUuid: string, botao: string, noExpediente: boolean): Regra | null {
  const b = normalizar(botao);
  const candidatas = regras.filter((r) => r.status !== "pausada" && r.origin_template_uuid === templateUuid && normalizar(r.origin_button) === b);
  const exata = candidatas.find((r) => r.janela === (noExpediente ? "expediente" : "fora"));
  return exata ?? candidatas.find((r) => r.janela === "sempre") ?? null;
}

/** Variáveis do Poli que o painel sabe preencher. */
export const VARIAVEIS_CONHECIDAS = ["contact_first_name", "contact_name", "operator_name"] as const;
export type Variavel = (typeof VARIAVEIS_CONHECIDAS)[number];

/** Variáveis do texto do template ([contact_first_name], ...), na ordem em que aparecem. */
export function variaveis(texto: string): string[] {
  return [...texto.matchAll(/\[([a-z_]+)\]/gi)].map((m) => m[1].toLowerCase());
}

/** Variáveis que o painel não sabe preencher: com qualquer uma, a regra não pode ser ativada (evita o erro 100). */
export function variaveisDesconhecidas(texto: string): string[] {
  return [...new Set(variaveis(texto).filter((v) => !(VARIAVEIS_CONHECIDAS as readonly string[]).includes(v)))];
}

export interface DadosEnvio {
  leadNome: string | null;
  sdrNome: string | null;
}

const primeiroNome = (n: string | null) => (n ?? "").trim().split(/\s+/)[0] ?? "";
// Nome que é só número (o Poli às vezes usa o telefone como nome) não vai para a mensagem.
const nomeUsavel = (n: string | null) => (n && !/^[\d\s+()-]+$/.test(n.trim()) ? n.trim() : "");

/**
 * Valores das variáveis, na ordem do texto. Sem valor para alguma variável, devolve qual faltou:
 * o worker pula o envio em vez de mandar a variável vazia (erro 100 da Meta).
 */
export function preencher(texto: string, d: DadosEnvio): { ok: true; params: string[] } | { ok: false; falta: string } {
  const params: string[] = [];
  for (const v of variaveis(texto)) {
    const valor = v === "contact_first_name" ? primeiroNome(nomeUsavel(d.leadNome))
      : v === "contact_name" ? nomeUsavel(d.leadNome)
      : v === "operator_name" ? primeiroNome(d.sdrNome)
      : "";
    if (!valor) return { ok: false, falta: v };
    params.push(valor);
  }
  return { ok: true, params };
}

/** Texto como o lead vai receber (prévia da tela). */
export function previa(texto: string, d: DadosEnvio): string {
  const r = preencher(texto, d);
  if (!r.ok) return texto;
  let i = 0;
  return texto.replace(/\[([a-z_]+)\]/gi, () => r.params[i++]);
}
