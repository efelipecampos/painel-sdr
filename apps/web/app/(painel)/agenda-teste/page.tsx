import { redirect } from "next/navigation";
import { isFree, type CalendarEvent, type Interval } from "@painel/shared/google";
import { calendarOf, withLog } from "@/lib/google";
import { createClient, getMe } from "@/lib/supabase/server";
import { addDays, formatDateTime, formatTime, localDay, localToDate } from "@/lib/time";
import { criarTeste, operarTeste } from "./actions";

export const metadata = { title: "Teste da agenda — Painel SDR" };

const HOURS = Array.from({ length: 26 }, (_, i) => `${String(7 + Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`);

// Tela de teste da 10c (só admin): livre/ocupado de um closer conectado e um evento de teste de ponta a ponta.
export default async function AgendaTestePage({ searchParams }: {
  searchParams: Promise<{ closer?: string; dia?: string; ev?: string; onde?: string; erro?: string }>;
}) {
  const me = await getMe();
  if (me?.role !== "admin") redirect("/");
  const sp = await searchParams;
  const db = (await createClient()).schema("painel");
  const [{ data: users }, { data: arq }] = await Promise.all([
    db.rpc("usuarios"),
    db.from("settings").select("value").eq("key", "google_archive_calendar_id").maybeSingle(),
  ]);
  const closers = ((users ?? []) as { sdr_id: string; name: string; agenda: string | null; active: boolean }[])
    .filter((u) => u.agenda === "conectada" && u.active);
  const archive = String(arq?.value ?? "").trim();
  const dia = sp.dia && /^\d{4}-\d{2}-\d{2}$/.test(sp.dia) ? sp.dia : localDay(new Date());
  const closer = closers.find((c) => c.sdr_id === sp.closer);

  let busy: Interval[] = [];
  let ev: CalendarEvent | null = null;
  let erro = sp.erro ?? null;
  if (closer) {
    try {
      const cal = await calendarOf(closer.sdr_id);
      busy = await withLog(closer.sdr_id, "livre_ocupado", () => cal.busy(localToDate(`${dia}T07:00`), localToDate(`${addDays(dia, 1)}T00:00`)));
      if (sp.ev) ev = await cal.get(sp.ev, sp.onde === "arquivo" ? archive : "primary");
    } catch (e) {
      erro = erro ?? (e as Error).message;
    }
  }
  const hidden = { closer: closer?.sdr_id ?? "", dia, ev: sp.ev ?? "", onde: sp.onde ?? "closer" };

  return (
    <main className="page">
      <div className="page-head"><h1 className="title">Teste da agenda</h1></div>
      {erro && <div className="alert" role="alert">{erro}</div>}
      <p className="muted" style={{ margin: 0 }}>
        Só para o administrador conferir a conexão com o Google. O evento de teste tem você como único convidado.
        {archive ? "" : " A agenda de arquivo ainda não foi cadastrada em Configurações."}
      </p>

      <form className="card group">
        <label className="lbl" htmlFor="closer">Closer</label>
        <select id="closer" name="closer" className="field" defaultValue={closer?.sdr_id ?? ""}>
          <option value="">{closers.length ? "Escolha…" : "Nenhum closer conectou a agenda ainda"}</option>
          {closers.map((c) => <option key={c.sdr_id} value={c.sdr_id}>{c.name}</option>)}
        </select>
        <label className="lbl" htmlFor="dia">Dia</label>
        <input id="dia" name="dia" type="date" className="field" defaultValue={dia} />
        <button className="btn small" type="submit">Ver agenda</button>
      </form>

      {closer && !erro && (
        <section className="card" style={{ gap: 12 }}>
          <h2 className="card-title">Horários de {closer.name} em {dia.split("-").reverse().join("/")} (reunião de 30 min, intervalo de 15 min)</h2>
          <div className="group" style={{ flexWrap: "wrap", gap: 6 }}>
            {HOURS.map((h) => {
              const s = localToDate(`${dia}T${h}`);
              const free = isFree(busy, s, new Date(s.getTime() + 30 * 60_000), 15);
              return <span key={h} className="btn small" style={{ opacity: free ? 1 : 0.4 }} title={free ? "Livre" : "Ocupado"}>{h} {free ? "livre" : "ocupado"}</span>;
            })}
          </div>
          <p className="muted" style={{ margin: 0 }}>
            Ocupado no Google: {busy.length ? busy.map((b) => `${formatTime(b.start)}–${formatTime(b.end)}`).join(", ") : "nada"}.
          </p>
          <form action={criarTeste} className="group">
            {Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
            <label className="lbl" htmlFor="hora">Criar evento de teste às</label>
            <select id="hora" name="hora" className="field">{HOURS.map((h) => <option key={h}>{h}</option>)}</select>
            <button className="btn small primary" type="submit">Criar</button>
          </form>
        </section>
      )}

      {closer && sp.ev && (
        <section className="card" style={{ gap: 12 }}>
          <h2 className="card-title">Evento de teste</h2>
          {ev ? (
            <>
              <p style={{ margin: 0 }}>
                <strong>{ev.summary}</strong> · {formatDateTime(ev.start?.dateTime)} · está na agenda {sp.onde === "arquivo" ? "de arquivo" : "do closer"}
              </p>
              <p style={{ margin: 0 }}>
                Meet: {ev.hangoutLink ? <a href={ev.hangoutLink} target="_blank" rel="noreferrer">{ev.hangoutLink}</a> : "—"}
                {ev.htmlLink && <> · <a href={ev.htmlLink} target="_blank" rel="noreferrer">abrir no Google Agenda</a></>}
              </p>
            </>
          ) : <p style={{ margin: 0 }}>O evento não foi encontrado no Google (apagado).</p>}
          <div className="group">
            {[
              ["mais1h", "Mudar para 1 hora depois", true],
              ["arquivar", "Mover para o arquivo", sp.onde !== "arquivo" && !!archive],
              ["voltar", "Trazer de volta ao closer", sp.onde === "arquivo"],
              ["apagar", "Apagar o teste", true],
            ].filter(([, , on]) => on && ev).map(([op, label]) => (
              <form key={String(op)} action={operarTeste}>
                {Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
                <input type="hidden" name="op" value={String(op)} />
                <button className="btn small" type="submit">{label}</button>
              </form>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
