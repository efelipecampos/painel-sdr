import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getMe, isManager } from "@/lib/supabase/server";
import { AutoRefresh } from "@/components/AutoRefresh";
import { Metric, staleLabel } from "@/components/Metric";
import { PeriodFilter } from "@/components/PeriodFilter";
import { getSdrChats, getSdrMetrics, getSettings, initials, type ChatRow } from "@/lib/data";
import { formatDateTime, formatDuration, resolvePeriod } from "@/lib/time";
import { MeetingSelect, MeetingStatusText } from "./MeetingSelect";

const PAGE = 50;
const FILTERS = [
  { key: "all", label: "Todos" },
  { key: "waiting", label: "Aguardando resposta" },
  { key: "noreply", label: "Lead não respondeu" },
  { key: "booked", label: "Com reunião" },
];
const FROM_LABEL: Record<string, string> = { lead: "Lead", sdr: "Equipe", template: "Template", bot: "Automação" };

function waitingFor(iso: string): string {
  return formatDuration((Date.now() - new Date(iso).getTime()) / 1000);
}

function Situacao({ r }: { r: ChatRow }) {
  switch (r.situacao) {
    case "aguardando":
      return <span className={`badge${r.parado ? " stale" : ""}`}>Aguardando há {waitingFor(r.waiting_since!)}</span>;
    case "respondido":
      return <span className="badge">Respondido</span>;
    case "lead_nao_respondeu":
      return <span className="badge dim">Lead não respondeu</span>;
    case "encerrado_sem_resposta":
      return <span className="badge dim">Encerrado sem resposta</span>;
    case "fora_do_funil":
      return <span className="badge dim">Fora do funil · {r.fora_motivo}</span>;
  }
}

export default async function SdrPage({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  // SDR só abre a própria tela (o banco também recusa sdr_chats de outro SDR).
  const me = await getMe();
  if (me?.role === "sdr" && me.sdrId !== id) redirect(`/sdr/${me.sdrId}`);
  const manager = isManager(me);
  const period = resolvePeriod(sp);
  const filter = FILTERS.some((f) => f.key === sp.filtro) ? sp.filtro! : "all";
  const search = sp.busca?.trim() || null;
  const page = Math.max(1, Number(sp.pagina) || 1);
  const [all, settings, rows] = await Promise.all([
    getSdrMetrics(period), getSettings(),
    getSdrChats(id, period, { filter, search, limit: PAGE, offset: (page - 1) * PAGE }),
  ]);
  const s = all.find((x) => x.sdr_id === id);
  if (!s) notFound();
  const total = rows[0]?.total ?? 0;
  const link = (next: Record<string, string | null>) => {
    const q = new URLSearchParams(Object.entries(sp).filter(([, v]) => v != null) as [string, string][]);
    for (const [k, v] of Object.entries(next)) (v === null ? q.delete(k) : q.set(k, v));
    return `/sdr/${id}?${q.toString()}`;
  };
  const back = new URLSearchParams(Object.entries(sp).filter(([k, v]) => v != null && ["periodo", "de", "ate", "ordem"].includes(k)) as [string, string][]).toString();

  return (
    <main className="page">
      <AutoRefresh seconds={60} />
      <div className="page-head">
        {manager && <Link href={`/${back ? `?${back}` : ""}`} className="btn small" aria-label="Voltar ao painel">‹ Painel</Link>}
        <div className="avatar" aria-hidden="true">{initials(s.name)}</div>
        <div className="cell-stack">
          <h1 className="title">{s.name}</h1>
          <span className="muted">{period.label}</span>
        </div>
      </div>

      <PeriodFilter current={period.key} fromLocal={period.fromLocal} toLocal={period.toLocal} />

      <section className="card" aria-label="Indicadores do SDR">
        <div className="metrics">
          <Metric label="Leads abordados" value={s.leads_abordados} />
          <Metric label="Templates enviados" value={s.templates_enviados} />
          <Metric label="Leads que responderam" value={s.leads_responderam} />
          <Metric label="1ª resposta (mediana)" value={formatDuration(s.primeira_resposta_s)} count={s.leads_primeira_resposta} />
          <Metric label="Tempo de resposta (mediana)" value={formatDuration(s.resposta_s)} count={s.leads_resposta} />
          <Metric label="Aguardando resposta" value={s.aguardando} sub={staleLabel(s.parados, settings.stale_minutes)} stale={s.parados > 0} />
          <Metric label="Agendados" value={s.agendados}
            sub={s.leads_abordados > 0 ? `${Math.round((s.agendados / s.leads_abordados) * 100)}% dos abordados` : "—"} />
          <Metric label="Descartados" value={s.descartados} />
        </div>
      </section>

      <div className="toolbar">
        <div className="group" role="group" aria-label="Filtrar chats">
          {FILTERS.map((f) => (
            <Link key={f.key} href={link({ filtro: f.key, pagina: null })} className="btn" aria-pressed={filter === f.key}>{f.label}</Link>
          ))}
        </div>
        <span className="spacer" />
        <form className="group" action={`/sdr/${id}`}>
          {Object.entries(sp).filter(([k, v]) => v != null && k !== "busca" && k !== "pagina").map(([k, v]) => (
            <input key={k} type="hidden" name={k} value={v} />
          ))}
          <label className="lbl" htmlFor="busca">Buscar lead</label>
          <input id="busca" name="busca" type="search" className="field" defaultValue={search ?? ""} placeholder="Nome ou telefone..." />
          <button type="submit" className="btn">Buscar</button>
        </form>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Lead</th>
              <th scope="col">Situação</th>
              <th scope="col">Origem</th>
              <th scope="col">Templates</th>
              <th scope="col">1ª resposta</th>
              <th scope="col">Resposta (mediana)</th>
              <th scope="col">Mensagens (lead / equipe)</th>
              <th scope="col">Última mensagem</th>
              <th scope="col">Reunião</th>
              <th scope="col"><span className="muted">Ações</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={10} className="muted">Nenhum lead com mensagem neste período.</td></tr>
            )}
            {rows.map((r) => (
              <tr key={r.lead_id}>
                <td><div className="cell-stack"><span>{r.lead_name ?? "(sem nome)"}</span><span className="muted">{r.phone_masked ?? "sem telefone"}</span></div></td>
                <td><Situacao r={r} /></td>
                <td>{r.origem === "lead" ? "Lead" : r.origem === "poli" ? "Poli" : "—"}</td>
                <td>{r.templates}</td>
                <td>{formatDuration(r.primeira_resposta_s)}</td>
                <td>{formatDuration(r.resposta_s)}</td>
                <td>{r.msgs_lead} / {r.msgs_equipe}</td>
                <td><div className="cell-stack"><span>{formatDateTime(r.last_message_at)}</span><span className="muted">{FROM_LABEL[r.last_message_from ?? ""] ?? ""}</span></div></td>
                <td>{manager
                  ? <MeetingSelect leadId={r.lead_id} leadName={r.lead_name ?? "lead"} status={r.reuniao_status} origem={r.reuniao_origem} />
                  : <MeetingStatusText status={r.reuniao_status} origem={r.reuniao_origem} />}</td>
                <td><a href={`https://app.poli.digital/chat/${r.poli_contact_uuid}`} target="_blank" rel="noreferrer" aria-label={`Abrir chat de ${r.lead_name ?? "lead"} no Poli`}>Abrir no Poli</a></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="pager">
          <span className="muted">{total === 0 ? "0 leads" : `${(page - 1) * PAGE + 1}–${(page - 1) * PAGE + rows.length} de ${total} leads`}</span>
          <span className="spacer" />
          {page > 1 ? <Link className="btn small" href={link({ pagina: String(page - 1) })}>Anterior</Link> : <button className="btn small" disabled>Anterior</button>}
          {page * PAGE < total ? <Link className="btn small" href={link({ pagina: String(page + 1) })}>Próxima</Link> : <button className="btn small" disabled>Próxima</button>}
        </div>
      </div>
    </main>
  );
}
