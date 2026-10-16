// Jornada · Acompanhamento (Fase 11): o funil simples de 4 etapas (decisão do Felipe em 2026-10-15), no desenho de
// design/JornadaAcompanhamento.dc.html. A conta é do banco (painel.jornada_funil); a tela só exibe.
import { redirect } from "next/navigation";
import { createClient, getMe, isManager } from "@/lib/supabase/server";
import { addDays, localDay, localToDate } from "@/lib/time";
import { JornadaTabs } from "../JornadaTabs";
import { FunilView, type Etapa } from "./FunilView";
import { PeriodoJornada } from "./PeriodoJornada";
import { PorTemplate, type LinhaTemplate } from "./PorTemplate";
import { carregarTemplates } from "../templates";
import s from "../jornada.module.css";

export const dynamic = "force-dynamic";

const ETAPAS = ["Lead criado", "Template 1 enviado", "Clicou em um dos botões", "Agendamento"];

/** Período em dias de São Paulo: hoje, 7 dias, este mês, mês passado ou de/até. Fim exclusivo. */
function periodo(sp: { periodo?: string; de?: string; ate?: string }) {
  const hoje = localDay(new Date());
  const mes = hoje.slice(0, 8) + "01";
  const mesPassado = addDays(mes, -1).slice(0, 8) + "01";
  const dia = /^\d{4}-\d{2}-\d{2}$/;
  if (sp.periodo === "custom" && sp.de && sp.ate && dia.test(sp.de) && dia.test(sp.ate) && sp.ate >= sp.de) return { key: "custom", de: sp.de, ate: sp.ate };
  if (sp.periodo === "hoje") return { key: "hoje", de: hoje, ate: hoje };
  if (sp.periodo === "7d") return { key: "7d", de: addDays(hoje, -6), ate: hoje };
  if (sp.periodo === "passado") return { key: "passado", de: mesPassado, ate: addDays(mes, -1) };
  return { key: "mes", de: mes, ate: hoje };
}

export default async function JornadaAcompanhamentoPage({ searchParams }: { searchParams: Promise<{ periodo?: string; de?: string; ate?: string; template?: string }> }) {
  const me = await getMe();
  if (!isManager(me)) redirect("/");
  const sp = await searchParams;
  const p = periodo(sp);
  const db = (await createClient()).schema("painel");
  const de = localToDate(`${p.de}T00:00`).toISOString(), ate = localToDate(`${addDays(p.ate, 1)}T00:00`).toISOString();
  const escolhido = sp.template ?? null;
  const [{ data, error }, templates] = await Promise.all([
    db.rpc("jornada_funil", { p_from: de, p_to: ate }),
    carregarTemplates(db, new Set(escolhido ? [escolhido] : [])),
  ]);
  const chave = escolhido ? templates.find((t) => t.uuid === escolhido)?.key ?? null : null;
  const { data: porTpl } = chave ? await db.rpc("template_resultado", { p_template: chave, p_from: de, p_to: ate }) : { data: null };
  const linhas = (data ?? []) as { etapa: number; nome: string; expediente: number; fora: number }[];
  const etapas: Etapa[] = ETAPAS.map((nome, i) => {
    const l = linhas.find((x) => x.etapa === i + 1);
    return { nome, exp: l?.expediente ?? 0, fora: l?.fora ?? 0 };
  });
  const atualizado = new Date().toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });

  return (
    <main className={s.page}>
      <JornadaTabs atual="acompanhamento" />
      <div className={s.periodBar}>
        <PeriodoJornada atual={p.key} de={p.de} ate={p.ate} />
        <div style={{ flexGrow: 1 }} />
        <span className={s.note}>Leads novos sem DSQ criados no período · atualizado às {atualizado}</span>
      </div>
      {error ? <div className={s.limitAlert}><span>Não foi possível calcular o funil agora. Tente de novo em instantes.</span></div> : <FunilView etapas={etapas} />}
      <PorTemplate templates={templates} escolhido={escolhido} linhas={chave ? ((porTpl ?? []) as LinhaTemplate[]) : null} />
    </main>
  );
}
