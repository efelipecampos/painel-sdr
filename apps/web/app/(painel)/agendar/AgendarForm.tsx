"use client";

import { useActionState, useEffect, useMemo, useState, useTransition } from "react";
import { buscarLeads, carregarLead, conferir, confirmar, diasDoCarrossel, horarios, type LeadLoaded, type LeadResult } from "./actions";

export interface CarouselOption {
  id: string; brand: "poli" | "chatshub"; name: string; description: string | null; durations: number[];
  suggest_min_users: number | null; suggest_max_users: number | null;
}

const BRAND = { poli: "Poli", chatshub: "ChatsHub" } as const;
const STATUS: Record<string, string> = { agendada: "Agendada", validada: "Validada", noshow: "No show", invalidada: "Invalidada", cancelada: "Cancelada" };
const fmtDay = (d: string) => {
  const dt = new Date(`${d}T12:00:00Z`);
  return `${dt.toLocaleDateString("pt-BR", { weekday: "short", timeZone: "UTC" }).replace(".", "")} ${d.slice(8, 10)}/${d.slice(5, 7)}`;
};
const fmtWhen = (iso: string) => new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const closers = (n: number) => (n === 1 ? "1 closer disponível" : `${n} closers disponíveis`);

export function AgendarForm({ carousels, initialLead, sdrs }: {
  carousels: CarouselOption[]; initialLead: string | null; sdrs: { id: string; name: string }[] | null;
}) {
  const [pending, start] = useTransition();
  // 1. lead
  const [q, setQ] = useState("");
  const [results, setResults] = useState<LeadResult[]>([]);
  const [ref, setRef] = useState("");
  const [lead, setLead] = useState<LeadLoaded | null>(null);
  const [email, setEmail] = useState("");
  // 2. reunião
  const [brand, setBrand] = useState<"poli" | "chatshub">("poli");
  const [carouselId, setCarouselId] = useState("");
  const [duration, setDuration] = useState(30);
  const [handoff, setHandoff] = useState("");
  const [sdrId, setSdrId] = useState("");
  // 3. horário
  const [days, setDays] = useState<string[]>([]);
  const [day, setDay] = useState("");
  const [slots, setSlots] = useState<{ start: string; count: number }[] | null>(null);
  const [local, setLocal] = useState("");
  const [manual, setManual] = useState<{ erro: string | null; avisos: string[]; count: number } | null>(null);
  const [state, action, confirming] = useActionState(confirmar, {});

  const carousel = carousels.find((c) => c.id === carouselId);
  const info = lead?.info;

  const load = (input: { leadId?: string; ref?: string }) => start(async () => {
    const r = await carregarLead(input);
    setLead(r);
    setEmail(r.info?.email ?? "");
    if (r.sugestao) {
      const sug = r.sugestao[brand] ?? r.sugestao.poli;
      if (sug) {
        const c = carousels.find((x) => x.id === sug)!;
        setBrand(c.brand);
        setCarouselId(c.id);
      }
    }
  });

  useEffect(() => {
    if (initialLead) load({ leadId: initialLead });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialLead]);

  useEffect(() => {
    if (q.trim().length < 2) { setResults([]); return; }
    const t = setTimeout(() => { buscarLeads(q).then(setResults).catch(() => setResults([])); }, 300);
    return () => clearTimeout(t);
  }, [q]);

  // carrossel mudou: recarrega os dias e limpa o horário
  useEffect(() => {
    setSlots(null); setLocal(""); setManual(null); setDay("");
    if (!carouselId) { setDays([]); return; }
    diasDoCarrossel(carouselId).then(setDays).catch(() => setDays([]));
  }, [carouselId]);

  const ids = useMemo(() => ({ leadId: lead?.leadId ?? null, contactId: info?.contactId ?? null }), [lead, info]);

  const pickDay = (d: string) => start(async () => {
    setDay(d); setLocal(""); setManual(null); setSlots(null);
    setSlots(await horarios({ carouselId, ...ids, day: d, duration }));
  });

  // Duração mudou: a contagem da grade e a conferência anterior deixam de valer.
  const changeDuration = (d: number, keepLocal: boolean) => {
    setDuration(d);
    setManual(null);
    if (!keepLocal) setLocal("");
    if (day) start(async () => setSlots(await horarios({ carouselId, ...ids, day, duration: d })));
  };

  const check = (l: string, dur: number) => start(async () => {
    setManual(null);
    const r = await conferir({ carouselId, ...ids, local: l, duration: dur });
    setManual({ erro: r.erro, avisos: r.avisos, count: r.count });
  });

  const canConfirm = !!info && !!carouselId && !!local && !!manual && !manual.erro && manual.count > 0 && (!sdrs || !!sdrId);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* 1. Lead */}
      <section className="card" style={{ gap: 10 }} aria-labelledby="s1">
        <h2 id="s1" className="card-title">1. Lead</h2>
        {!info && (
          <>
            <label className="lbl" htmlFor="busca">Buscar entre os seus leads (nome, empresa ou final do telefone)</label>
            <input id="busca" className="field" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ex.: Maria, Empresa X, 1234" />
            {results.length > 0 && (
              <div className="cell-stack" style={{ gap: 4 }}>
                {results.map((r) => (
                  <button key={r.lead_id} type="button" className="btn small" style={{ justifyContent: "flex-start" }} onClick={() => load({ leadId: r.lead_id })}>
                    {r.name ?? "Sem nome"}{r.company ? ` · ${r.company}` : ""}{r.phone_final ? ` · final ${r.phone_final}` : ""}
                  </button>
                ))}
              </div>
            )}
            <label className="lbl" htmlFor="ref">Não achou? Cole o link do Contato ou do Lead no HubSpot (ou o ID)</label>
            <div className="group">
              <input id="ref" className="field" style={{ flex: 1 }} value={ref} onChange={(e) => setRef(e.target.value)} />
              <button type="button" className="btn small" disabled={!ref.trim() || pending} onClick={() => load({ ref, leadId: lead?.leadId ?? undefined })}>Buscar no HubSpot</button>
            </div>
          </>
        )}
        {pending && !info && <span className="muted">Consultando o HubSpot…</span>}
        {lead?.erro && <div className="alert" role="alert">{lead.erro}</div>}
        {info && (
          <>
            <div className="group" style={{ flexWrap: "wrap", gap: 16 }}>
              <span><strong>{info.name ?? "Sem nome"}</strong>{info.company ? ` · ${info.company}` : ""}</span>
              {info.phone && <span className="muted">{info.phone}</span>}
              {info.website && <span className="muted">{info.website}</span>}
              <span className="muted">Dono: {info.ownerName ?? "—"}</span>
              <span className="muted">Etapa: {info.stageLabel ?? "—"}</span>
              <span className="muted">Usuários: {info.users ?? "não informado"}</span>
              <span className="spacer" />
              <button type="button" className="btn small" onClick={() => { setLead(null); setCarouselId(""); }}>Trocar lead</button>
            </div>
            <label className="lbl" htmlFor="email">E-mail do lead (recebe o convite do Google; corrija se precisar)</label>
            <input id="email" type="email" className="field" value={email} onChange={(e) => setEmail(e.target.value)} />
            {lead?.reunioes && lead.reunioes.length > 0 && (
              <div className="alert" role="status" style={{ display: "block" }}>
                <strong>Reuniões já agendadas com este lead:</strong>
                <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                  {lead.reunioes.map((r) => (
                    <li key={r.id}>{fmtWhen(r.starts_at)} · {STATUS[r.status] ?? r.status} · {r.carousel ?? "—"} · closer {r.closer ?? "—"} · SDR {r.sdr ?? "—"}</li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </section>

      {/* 2. Reunião */}
      {info && (
        <section className="card" style={{ gap: 10 }} aria-labelledby="s2">
          <h2 id="s2" className="card-title">2. Reunião</h2>
          <div className="group">
            <span className="lbl">Empresa</span>
            {(["poli", "chatshub"] as const).map((b) => (
              <button key={b} type="button" className={`btn small${brand === b ? " primary" : ""}`} aria-pressed={brand === b}
                onClick={() => { setBrand(b); setCarouselId(lead?.sugestao?.[b] ?? ""); }}>{BRAND[b]}</button>
            ))}
          </div>
          <label className="lbl" htmlFor="car">Carrossel</label>
          <select id="car" className="field" value={carouselId} onChange={(e) => setCarouselId(e.target.value)}>
            <option value="">Escolha…</option>
            {carousels.filter((c) => c.brand === brand).map((c) => (
              <option key={c.id} value={c.id}>{c.name}{lead?.sugestao?.[brand] === c.id ? " (sugerido pelo nº de usuários)" : ""}</option>
            ))}
          </select>
          {carousel?.description && <span className="muted">{carousel.description}</span>}
          <div className="group">
            <span className="lbl">Duração</span>
            {(carousel?.durations ?? [30, 45, 60]).map((d) => (
              <button key={d} type="button" className={`btn small${duration === d ? " primary" : ""}`} aria-pressed={duration === d} onClick={() => changeDuration(d, false)}>{d} min</button>
            ))}
          </div>
          {sdrs && (
            <>
              <label className="lbl" htmlFor="sdr">SDR responsável</label>
              <select id="sdr" className="field" value={sdrId} onChange={(e) => setSdrId(e.target.value)}>
                <option value="">Escolha…</option>
                {sdrs.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </>
          )}
          <label className="lbl" htmlFor="handoff">Passagem de bastão (só a equipe vê; o lead não)</label>
          <textarea id="handoff" className="field" rows={4} maxLength={4000} value={handoff} onChange={(e) => setHandoff(e.target.value)}
            placeholder="Contexto do lead, dores, o que foi combinado, quem participa…" />
        </section>
      )}

      {/* 3. Horário */}
      {info && carouselId && (
        <section className="card" style={{ gap: 10 }} aria-labelledby="s3">
          <h2 id="s3" className="card-title">3. Horário</h2>
          <div className="group" style={{ flexWrap: "wrap", gap: 6 }}>
            {days.map((d) => (
              <button key={d} type="button" className={`btn small${day === d ? " primary" : ""}`} aria-pressed={day === d} onClick={() => pickDay(d)}>{fmtDay(d)}</button>
            ))}
          </div>
          {pending && <span className="muted">Consultando as agendas…</span>}
          {slots && slots.length === 0 && <span className="muted">Nenhum horário neste dia.</span>}
          {slots && slots.length > 0 && (
            <div className="group" style={{ flexWrap: "wrap", gap: 6 }}>
              {slots.map((s) => {
                const l = `${day}T${s.start}`;
                return (
                  <button key={s.start} type="button" disabled={s.count === 0}
                    className={`btn small${local === l ? " primary" : ""}`} aria-pressed={local === l}
                    onClick={() => { setLocal(l); setManual({ erro: null, avisos: [], count: s.count }); }}>
                    {s.start} · {s.count === 0 ? "sem closer" : closers(s.count)}
                  </button>
                );
              })}
            </div>
          )}
          {day && (
            <div className="group">
              <span className="lbl">Ajustar horário</span>
              <input type="time" className="field" aria-label="Início" value={local.slice(11) || ""} onChange={(e) => { if (e.target.value) { setLocal(`${day}T${e.target.value}`); setManual(null); } }} />
              <input type="number" className="field" style={{ width: 90 }} min={10} max={240} aria-label="Duração em minutos" value={duration}
                onChange={(e) => changeDuration(Number(e.target.value) || 30, true)} />
              <span className="muted">min</span>
              <button type="button" className="btn small" disabled={!local || pending} onClick={() => check(local, duration)}>Conferir agenda</button>
            </div>
          )}
          {manual?.erro && <div className="alert" role="alert">{manual.erro}</div>}
          {manual && !manual.erro && (
            <div role="status" className={manual.count > 0 ? "ok" : "alert"}>
              {local.slice(8, 10)}/{local.slice(5, 7)} às {local.slice(11)} · {duration} min · {manual.count > 0 ? closers(manual.count) : "nenhum closer livre neste horário"}
              {manual.avisos.length > 0 && <> · Fora do horário padrão: {manual.avisos.join("; ")}</>}
            </div>
          )}
        </section>
      )}

      {info && carouselId && (
        <form action={action} className="group">
          <input type="hidden" name="carouselId" value={carouselId} />
          <input type="hidden" name="local" value={local} />
          <input type="hidden" name="duration" value={duration} />
          <input type="hidden" name="email" value={email} />
          <input type="hidden" name="handoff" value={handoff} />
          <input type="hidden" name="leadId" value={lead?.leadId ?? ""} />
          <input type="hidden" name="contactId" value={info.contactId} />
          <input type="hidden" name="sdrId" value={sdrId} />
          {state.erro && <div className="alert" role="alert" style={{ flex: 1 }}>{state.erro}</div>}
          <span className="spacer" />
          <button type="submit" className="btn primary" disabled={!canConfirm || confirming}>{confirming ? "Agendando…" : "Confirmar agendamento"}</button>
        </form>
      )}
    </div>
  );
}
