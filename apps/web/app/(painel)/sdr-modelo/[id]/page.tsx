import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient, getMe, isManager } from "@/lib/supabase/server";
import { anterior, fmtFaixa, fmtValor, resolveDias, textoAnterior } from "@/lib/sdr-modelo";
import { formatDuration } from "@/lib/time";
import { comportamentosAtivos, carregar } from "../dados";
import { DateRange } from "../DateRange";
import { SdrSelect } from "./SdrSelect";
import { UmView, type Exemplo, type UmComp } from "./UmView";
import s from "../modelo.module.css";

export const metadata = { title: "SDR Modelo — Painel SDR" };

interface ExRow { tipo: "melhorar" | "bom"; lead_id: string; lead_name: string | null; poli_contact_uuid: string | null; quando: string; segundos: number | null; status: string | null }

const COM_EXEMPLO = ["pri", "res", "val", "conf"];
const STATUS: Record<string, string> = {
  validada: "Reunião validada", invalidada: "Reunião invalidada", noshow: "Lead não apareceu (no show)",
  confirmou: "Alguém da equipe escreveu na hora antes da reunião", sem_confirmacao: "Ninguém da equipe escreveu na hora antes da reunião",
};

// Fase 9b: um SDR (design/SDRModeloUm.dc.html). O SDR vê só a própria; gestor e admin escolhem o SDR.
export default async function SdrModeloUmPage({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>>;
}) {
  const me = await getMe();
  const { id } = await params;
  const sp = await searchParams;
  if (me?.role === "sdr") { if (me.sdrId && me.sdrId !== id) redirect(`/sdr-modelo/${me.sdrId}`); }
  else if (!isManager(me)) redirect("/");
  const gestor = isManager(me);

  const p = resolveDias(sp);
  const pa = anterior(p);
  const [{ linhas, numeros, versao, diasFaltando }, antes] = await Promise.all([carregar(p.from, p.to), carregar(pa.from, pa.to)]);
  const db = (await createClient()).schema("painel");
  const exemplos = Object.fromEntries(await Promise.all(COM_EXEMPLO.map(async (c) => {
    const { data, error } = await db.rpc("sdr_modelo_exemplos", { p_sdr: id, p_from: p.from.toISOString(), p_to: p.to.toISOString(), p_comportamento: c });
    if (error) throw new Error(`Não foi possível ler os exemplos: ${error.message}`);
    return [c, (data ?? []) as ExRow[]] as const;
  })));

  const n = numeros.find((x) => x.sdr_id === id);
  const minhas = linhas.filter((l) => l.sdr_id === id);
  const nome = n?.name ?? minhas[0]?.name ?? "SDR";
  const aderencia = minhas[0]?.aderencia ?? null;
  const aderenciaAntes = antes.linhas.find((l) => l.sdr_id === id)?.aderencia ?? null;

  const ex = (c: string, r: ExRow): Exemplo => ({
    tipo: r.tipo, lead: r.lead_name ?? "Lead sem nome", quando: r.quando,
    nota: r.segundos != null ? `${c === "pri" ? "1ª resposta" : "Resposta"} em ${formatDuration(r.segundos)}` : STATUS[r.status ?? ""] ?? "",
    link: r.poli_contact_uuid ? `https://app.poli.digital/chat/${r.poli_contact_uuid}` : null,
  });
  const comps: UmComp[] = comportamentosAtivos(versao, linhas).map((c) => {
    const l = minhas.find((x) => x.comportamento === c.id);
    return {
      id: c.id, grupo: c.grupo, nome: c.nome, medida: c.medida, peso: c.peso, unidade: c.unidade,
      lo: c.lo, hi: c.hi, valorNum: l?.valor != null ? Number(l.valor) : null,
      valor: fmtValor(c.unidade, l?.valor), faixa: fmtFaixa(c.unidade, c.lo, c.hi), situacao: l?.situacao ?? "sem_dado",
      exemplos: COM_EXEMPLO.includes(c.id) ? (exemplos[c.id] ?? []).map((r) => ex(c.id, r)) : null,
    };
  });
  const qs = `?de=${p.de}&ate=${p.ate}`;
  const opcoes = gestor ? [...numeros].filter((x) => x.leads_abordados > 0 || x.reunioes > 0 || x.sdr_id === id)
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR")).map((x) => ({ id: x.sdr_id, name: x.name })) : [];

  return (
    <main className={s.page}>
      <div className={s.head}>
        {gestor && (
          <Link href={`/sdr-modelo${qs}`} aria-label="Voltar para a visão do time" className={s.back}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 6l-6 6l6 6" /></svg>
          </Link>
        )}
        <div className={s.headText}>
          <h1 className={s.h1}>{gestor ? `SDR Modelo · ${nome}` : "Meu SDR Modelo"}</h1>
          <p className={s.sub}>
            {gestor
              ? "Onde este SDR está dentro e fora do SDR Ideal, com exemplos de conversas para levar ao 1:1."
              : "Onde você está dentro e fora do SDR Ideal, com exemplos das suas conversas. Serve para treino, não é ranking."}
          </p>
        </div>
        <span className={s.grow} />
        <div className={s.filters}>
          {gestor && <SdrSelect id={id} opcoes={opcoes} qs={qs} />}
          <DateRange de={p.de} ate={p.ate} />
        </div>
      </div>

      {diasFaltando > 0 && <div className="alert" role="status">Ainda calculando {diasFaltando} {diasFaltando === 1 ? "dia" : "dias"} deste período. Recarregue a página em alguns segundos.</div>}
      {!versao || !comps.length
        ? <div className="card"><p className={s.empty}>Sem dados do SDR Modelo neste período.</p></div>
        : <UmView aderencia={aderencia} anterior={textoAnterior(aderencia, aderenciaAntes)} comps={comps} inicial={sp.c ?? null} />}

      <p className={s.foot}>
        Período de {p.de.split("-").reverse().join("/")} a {p.ate.split("-").reverse().join("/")}
        {n && ` · ${n.leads_abordados} leads abordados, ${n.leads_responderam} responderam, ${n.reunioes} ${n.reunioes === 1 ? "reunião" : "reuniões"}`}.
        {versao && ` SDR Ideal versão ${versao.versao}.`} A comparação usa o período anterior do mesmo tamanho.
      </p>
    </main>
  );
}
