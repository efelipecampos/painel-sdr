import Link from "next/link";
import { redirect } from "next/navigation";
import { getMe, isManager } from "@/lib/supabase/server";
import { fmtFaixa, fmtValor, resolveDias } from "@/lib/sdr-modelo";
import { comportamentosAtivos, carregar } from "./dados";
import { DateRange } from "./DateRange";
import { TimeView, type TimeComp, type TimeSdr } from "./TimeView";
import s from "./modelo.module.css";

export const metadata = { title: "SDR Modelo — Painel SDR" };

// Fase 9b: visão do time (design/SDRModeloTime.dc.html). Comportamentos nas linhas, SDRs nas colunas.
export default async function SdrModeloTimePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const me = await getMe();
  if (me?.role === "sdr" && me.sdrId) redirect(`/sdr-modelo/${me.sdrId}`);
  if (!isManager(me)) redirect("/");
  const p = resolveDias(await searchParams);
  const { linhas, numeros, versao, diasFaltando } = await carregar(p.from, p.to);
  const qs = `?de=${p.de}&ate=${p.ate}`;

  // SDRs com atividade no período, em ordem alfabética (não é ranking)
  const ativos = numeros.filter((n) => n.leads_abordados > 0 || n.reunioes > 0).sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  const porSdr = new Map(linhas.map((l) => [`${l.sdr_id}|${l.comportamento}`, l]));
  const sdrs: TimeSdr[] = ativos.map((n) => ({
    id: n.sdr_id, name: n.name,
    aderencia: linhas.find((l) => l.sdr_id === n.sdr_id)?.aderencia ?? null,
    base: `${n.leads_responderam} responderam · ${n.reunioes} ${n.reunioes === 1 ? "reunião" : "reuniões"}`,
  }));
  const comps: TimeComp[] = comportamentosAtivos(versao, linhas).map((c) => ({
    id: c.id, grupo: c.grupo, nome: c.nome, medida: c.medida, peso: c.peso, faixa: fmtFaixa(c.unidade, c.lo, c.hi),
    cells: Object.fromEntries(ativos.map((n) => {
      const l = porSdr.get(`${n.sdr_id}|${c.id}`);
      return [n.sdr_id, { valor: fmtValor(c.unidade, l?.valor), situacao: l?.situacao ?? "sem_dado" }];
    })),
  }));

  return (
    <main className={s.page}>
      <div className={s.head}>
        <div className={s.headText}>
          <h1 className={s.h1}>SDR Modelo · visão do time</h1>
          <p className={s.sub}>Onde cada SDR está fora do SDR Ideal, para levar ao 1:1. Não é ranking: os SDRs aparecem em ordem alfabética.</p>
        </div>
        <span className={s.grow} />
        <div className={s.filters}>
          <DateRange de={p.de} ate={p.ate} />
          <Link href="/sdr-modelo/ideal" className={s.btnOutline}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" /><circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="18" r="2" /></svg>
            SDR Ideal
          </Link>
        </div>
      </div>
      {diasFaltando > 0 && <div className="alert" role="status">Ainda calculando {diasFaltando} {diasFaltando === 1 ? "dia" : "dias"} deste período. Recarregue a página em alguns segundos.</div>}
      {!versao
        ? <div className="card"><p className={s.empty}>Ainda não há versão do SDR Ideal.</p></div>
        : sdrs.length === 0
          ? <div className="card"><p className={s.empty}>Nenhum SDR com atividade neste período.</p></div>
          : <TimeView sdrs={sdrs} comps={comps} qs={qs} />}
      <p className={s.foot}>
        Aderência = soma dos pesos dos comportamentos na faixa ou melhores que ela (descartes não têm lado melhor) ÷ soma dos pesos
        dos comportamentos avaliados, de 0 a 100. Amostra pequena (menos de 10 respostas na mediana ou menos de 3 reuniões) fica fora
        da conta. {versao && `SDR Ideal versão ${versao.versao}, a que estava em uso no fim do período.`} Comportamentos de conversa
        (avaliados pela IA) entram numa próxima etapa.
      </p>
    </main>
  );
}
