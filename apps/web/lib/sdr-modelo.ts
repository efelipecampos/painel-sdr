// SDR Modelo (Fase 9b): formatação e montagem das telas. Os números e a aderência vêm do banco
// (painel.sdr_modelo_aderencia, painel.sdr_modelo_numeros); aqui só se exibe.
import { addDays, formatDuration, localDay, localToDate } from "./time";

export type Grupo = "num" | "ia";
export type Situacao = "dentro" | "melhor" | "acima" | "abaixo" | "amostra_pequena" | "sem_dado";

/** Um comportamento da versão do SDR Ideal (painel.sdr_ideal_versoes.comportamentos). */
export interface Comportamento {
  id: string; grupo: Grupo; nome: string; medida: string; unidade: string;
  lo: number | null; hi: number | null; melhor: number; peso: number; ativo: boolean; descricao?: string;
}

/** Linha de painel.sdr_modelo_aderencia. */
export interface Aderencia {
  sdr_id: string; name: string; versao: number; comportamento: string; valor: number | null; base: number | null;
  lo: number | null; hi: number | null; melhor: number; peso: number; situacao: Situacao; aderencia: number | null;
}

/** Linha de painel.sdr_modelo_numeros (só o que a tela usa). */
export interface Numeros { sdr_id: string; name: string; leads_abordados: number; leads_responderam: number; reunioes: number }

export const GRUPOS: { id: Grupo; label: string }[] = [
  { id: "num", label: "Números (calculados no banco)" },
  { id: "ia", label: "Conversa (avaliada pela IA)" },
];

export const ok = (s: Situacao) => s === "dentro" || s === "melhor";
export const fora = (s: Situacao) => s === "acima" || s === "abaixo";
export const avaliado = (s: Situacao) => ok(s) || fora(s);

export function rotulo(s: Situacao): string {
  return {
    dentro: "na faixa", melhor: "melhor que a faixa", acima: "acima da faixa", abaixo: "abaixo da faixa",
    amostra_pequena: "amostra pequena", sem_dado: "sem dado",
  }[s];
}

const num = (v: number, casas: number) => v.toLocaleString("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: casas });

/** Valor na unidade do comportamento: "63,2", "3min08", "8,2%", "7,4". */
export function fmtValor(unidade: string, v: number | null | undefined): string {
  if (v == null) return "—";
  const n = Number(v);
  if (unidade === "s") return formatDuration(n);
  if (unidade === "%") return `${num(n, 1)}%`;
  return num(n, 1);
}

/** Faixa ideal: "63,2 a 118,6", "3min08 a 20min22", "6% a 8,2%". Sem faixa: "sem faixa". */
export function fmtFaixa(unidade: string, lo: number | null, hi: number | null): string {
  if (lo == null || hi == null) return "sem faixa";
  return `${fmtValor(unidade, lo)} a ${fmtValor(unidade, hi)}`;
}

export interface Periodo { de: string; ate: string; from: Date; to: Date; dias: number }

/** De/até em dias inteiros (AAAA-MM-DD, até inclusive). Padrão: os últimos 30 dias, com hoje. */
export function resolveDias(sp: { de?: string; ate?: string }, now = new Date()): Periodo {
  const hoje = localDay(now);
  const valido = (d?: string) => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d);
  let ate = valido(sp.ate) ? sp.ate! : hoje;
  let de = valido(sp.de) ? sp.de! : addDays(ate, -29);
  if (de > ate) [de, ate] = [ate, de];
  const from = localToDate(`${de}T00:00`);
  const to = localToDate(`${addDays(ate, 1)}T00:00`);
  return { de, ate, from, to, dias: Math.round((to.getTime() - from.getTime()) / 86_400_000) };
}

/** O período anterior, do mesmo tamanho, terminando onde este começa. */
export function anterior(p: Periodo): Periodo {
  const ate = addDays(p.de, -1);
  const de = addDays(p.de, -p.dias);
  return resolveDias({ de, ate });
}

/** Treino coletivo: metade dos SDRs avaliados ou mais fora da faixa. */
export function coletivo(situacoes: Situacao[]): { fora: number; avaliados: number; coletivo: boolean } {
  const avaliados = situacoes.filter(avaliado).length;
  const f = situacoes.filter(fora).length;
  return { fora: f, avaliados, coletivo: avaliados > 0 && f / avaliados >= 0.5 };
}

/** Diferença da aderência para o período anterior: "+10 desde o período anterior". */
export function textoAnterior(atual: number | null, antes: number | null): string {
  if (atual == null || antes == null) return "Sem comparação com o período anterior";
  const d = atual - antes;
  if (d === 0) return "Igual ao período anterior";
  return `${d > 0 ? "+" : "−"}${Math.abs(d)} desde o período anterior (${antes})`;
}

// ---- Configuração do SDR Ideal (tela de edição) ----

/** Linha do formulário: números como texto (inputs); tempo em minutos na tela, segundos no banco. */
export interface Edicao {
  id: string; grupo: Grupo; nome: string; medida: string; unidade: string;
  lo: string; hi: string; melhor: string; peso: string; ativo: boolean; descricao: string; novo?: boolean;
}

export const UNIDADE_TELA: Record<string, string> = { "leads/dia": "leads/dia", s: "min", "%": "%", nota: "nota 0 a 10" };
const LADO: Record<string, string> = { "1": "maior é melhor", "-1": "menor é melhor", "0": "só a faixa" };

const paraTela = (unidade: string, v: number | null) =>
  v == null ? "" : String(unidade === "s" ? Math.round((Number(v) / 60) * 10) / 10 : Number(v));
const doTela = (unidade: string, v: string): number | null => {
  if (v.trim() === "") return null;
  const n = Number(v.replace(",", "."));
  if (!Number.isFinite(n)) return null;
  return unidade === "s" ? Math.round(n * 60) : n;
};

export function paraEdicao(c: Comportamento): Edicao {
  return {
    id: c.id, grupo: c.grupo, nome: c.nome, medida: c.medida, unidade: c.unidade,
    lo: paraTela(c.unidade, c.lo), hi: paraTela(c.unidade, c.hi), melhor: String(c.melhor ?? 0),
    peso: String(c.peso ?? 0), ativo: c.ativo, descricao: c.descricao ?? "",
  };
}

export function daEdicao(e: Edicao): Comportamento {
  const c: Comportamento = {
    id: e.id, grupo: e.grupo, nome: e.nome.trim(), medida: e.medida, unidade: e.unidade,
    lo: doTela(e.unidade, e.lo), hi: doTela(e.unidade, e.hi), melhor: Number(e.melhor), peso: Number(e.peso) || 0, ativo: e.ativo,
  };
  if (e.grupo === "ia") c.descricao = e.descricao.trim();
  return c;
}

export const somaAtivos = (rows: Edicao[]) => rows.filter((r) => r.ativo).reduce((t, r) => t + (Number(r.peso) || 0), 0);

/** O que mudou, em português, para o histórico de versões. */
export function mudancas(base: Comportamento[], rows: Edicao[]): string[] {
  const out: string[] = [];
  const porId = new Map(base.map((b) => [b.id, paraEdicao(b)]));
  const tela = (e: Edicao, v: string) => (v === "" ? "—" : `${v.replace(".", ",")}${e.unidade === "%" ? "%" : ""}`);
  for (const r of rows) {
    const b = porId.get(r.id);
    if (!b) { out.push(`Novo comportamento de conversa: ${r.nome.trim()}`); continue; }
    if (r.nome.trim() !== b.nome) out.push(`${b.nome} renomeado para ${r.nome.trim()}`);
    if (r.ativo !== b.ativo) out.push(`${r.nome.trim()} ${r.ativo ? "ligado" : "desligado"}`);
    if (Number(r.peso) !== Number(b.peso)) out.push(`${r.nome.trim()}: peso ${b.peso} → ${r.peso}`);
    if (doTela(r.unidade, r.lo) !== doTela(b.unidade, b.lo) || doTela(r.unidade, r.hi) !== doTela(b.unidade, b.hi)) {
      out.push(`${r.nome.trim()}: faixa ${tela(b, b.lo)} a ${tela(b, b.hi)} → ${tela(r, r.lo)} a ${tela(r, r.hi)}${r.unidade === "s" ? " min" : ""}`);
    }
    if (r.melhor !== b.melhor) out.push(`${r.nome.trim()}: ${LADO[b.melhor]} → ${LADO[r.melhor]}`);
    if (r.grupo === "ia" && r.descricao.trim() !== b.descricao.trim()) out.push(`${r.nome.trim()}: o que a IA olha mudou`);
  }
  return out;
}

/** Por que não dá para salvar (mesmas regras do banco), ou null. */
export function impedimento(rows: Edicao[]): string | null {
  const soma = somaAtivos(rows);
  if (soma !== 100) return `Os pesos dos comportamentos ativos somam ${soma}. Precisam somar 100 para salvar.`;
  if (rows.some((r) => !r.nome.trim())) return "Todo comportamento precisa de nome.";
  if (rows.some((r) => r.grupo === "ia" && r.ativo && !r.descricao.trim())) return "Falta escrever o que a IA olha em um comportamento de conversa.";
  if (rows.some((r) => r.peso.trim() === "" || !(Number(r.peso) >= 0))) return "Todo peso precisa ser um número a partir de 0.";
  if (rows.some((r) => (r.lo.trim() !== "" && doTela(r.unidade, r.lo) == null) || (r.hi.trim() !== "" && doTela(r.unidade, r.hi) == null))) return "Uma faixa tem um valor que não é número.";
  if (rows.some((r) => { const lo = doTela(r.unidade, r.lo), hi = doTela(r.unidade, r.hi); return lo != null && hi != null && lo > hi; })) {
    return 'Uma faixa está com o "de" maior que o "até".';
  }
  return null;
}
