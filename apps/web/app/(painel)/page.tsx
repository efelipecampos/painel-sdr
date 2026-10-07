import Link from "next/link";
import { redirect } from "next/navigation";
import { getMe } from "@/lib/supabase/server";
import { AutoRefresh } from "@/components/AutoRefresh";
import { Metric, staleLabel } from "@/components/Metric";
import { PeriodFilter } from "@/components/PeriodFilter";
import { SortSelect } from "@/components/SortSelect";
import { getSdrMetrics, getSettings, getTeamMetrics, initials, type SdrMetrics } from "@/lib/data";
import { formatDuration, formatTime, resolvePeriod } from "@/lib/time";

const SORTS: Record<string, (a: SdrMetrics, b: SdrMetrics) => number> = {
  aguardando: (a, b) => b.aguardando - a.aguardando || b.parados - a.parados,
  primeira: (a, b) => (b.primeira_resposta_s ?? -1) - (a.primeira_resposta_s ?? -1),
  resposta: (a, b) => (b.resposta_s ?? -1) - (a.resposta_s ?? -1),
  abordados: (a, b) => b.leads_abordados - a.leads_abordados,
  descartados: (a, b) => b.descartados - a.descartados,
  agendados: (a, b) => b.agendados - a.agendados,
};

function pct(n: number, base: number): string {
  return base > 0 ? `${Math.round((n / base) * 100)}% dos abordados` : "—";
}

export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  // SDR não vê o painel do time: vai para os próprios chats (o banco também recusa team_metrics para ele).
  const period = resolvePeriod(sp);
  const sortKey = sp.ordem && SORTS[sp.ordem] ? sp.ordem : "aguardando";
  // Dados em paralelo com a conferência do usuário (cada ida ao banco custa ~200 ms).
  const data = Promise.all([getTeamMetrics(period), getSdrMetrics(period), getSettings()]);
  data.catch(() => {}); // SDR: o banco recusa team_metrics; ele é redirecionado abaixo
  const me = await getMe(); // já carregado pelo layout (cache)
  if (me?.role === "sdr") redirect(`/sdr/${me.sdrId}`);
  const [team, sdrs, settings] = await data;
  const list = [...sdrs].sort(SORTS[sortKey]);
  const qs = new URLSearchParams(Object.entries(sp).filter(([, v]) => v != null) as [string, string][]).toString();
  const timeMode = settings.metrics_business_only
    ? "Tempos: só leads que escreveram no horário comercial"
    : "Tempos: todos os leads, a qualquer hora";

  return (
    <main className="page">
      <AutoRefresh seconds={60} />
      <div className="page-head">
        <h1 className="title">Painel SDR</h1>
        <span className="spacer" />
        <span className="muted">Atualizado às {formatTime(new Date())} · {timeMode}</span>
      </div>

      <div className="toolbar">
        <PeriodFilter current={period.key} fromLocal={period.fromLocal} toLocal={period.toLocal} />
        <span className="spacer" />
        <SortSelect value={sortKey} />
      </div>

      <section className="card" aria-label="Resumo do time">
        <div className="group">
          <h2 className="card-title">Time · {team.sdrs} SDRs</h2>
          <span className="muted">{period.label}</span>
        </div>
        <div className="metrics">
          <Metric label="Leads abordados" value={team.leads_abordados} />
          <Metric label="Templates enviados" value={team.templates_enviados} />
          <Metric label="Leads que responderam" value={team.leads_responderam} />
          <Metric label="1ª resposta (mediana)" value={formatDuration(team.primeira_resposta_s)} count={team.leads_primeira_resposta} />
          <Metric label="Tempo de resposta (mediana)" value={formatDuration(team.resposta_s)} count={team.leads_resposta} />
          <Metric label="Aguardando resposta" value={team.aguardando} sub={staleLabel(team.parados, settings.stale_minutes)} stale={team.parados > 0} />
          <Metric label="Agendados" value={team.agendados} sub={pct(team.agendados, team.leads_abordados)} />
          <Metric label="Descartados" value={team.descartados} />
          <Metric label="DSQ" value={team.dsq} />
          <Metric label="Cadastro → disparo (mediana)" value={formatDuration(team.disparo_mediana_s)} sub={`${team.cadastros} cadastros`} />
          <Metric label="Cadastros sem disparo" value={team.cadastros_sem_disparo} sub="fora de DSQ, sem template em 30 min"
            stale={team.cadastros_sem_disparo > 0} />
        </div>
      </section>

      <div className="grid-cards">
        {list.map((s) => (
          <Link key={s.sdr_id} href={`/sdr/${s.sdr_id}${qs ? `?${qs}` : ""}`} className="card" aria-label={`Ver chats de ${s.name}`}>
            <div className="card-head">
              <div className="avatar" aria-hidden="true">{initials(s.name)}</div>
              <h3 className="card-title" style={{ flex: 1 }}>{s.name}</h3>
              <span className="muted">Ver chats ›</span>
            </div>
            <div className="metrics" style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
              <Metric label="Leads abordados" value={s.leads_abordados} />
              <Metric label="Templates enviados" value={s.templates_enviados} />
              <Metric label="Leads que responderam" value={s.leads_responderam} />
              <Metric label="Agendados" value={s.agendados} sub={pct(s.agendados, s.leads_abordados)} />
              <Metric label="Descartados" value={s.descartados} />
              <Metric label="1ª resposta (mediana)" value={formatDuration(s.primeira_resposta_s)} count={s.leads_primeira_resposta} />
              <Metric label="Tempo de resposta (mediana)" value={formatDuration(s.resposta_s)} count={s.leads_resposta} />
              <Metric label="Aguardando resposta" value={s.aguardando} sub={staleLabel(s.parados, settings.stale_minutes)} stale={s.parados > 0} />
            </div>
          </Link>
        ))}
      </div>
    </main>
  );
}
