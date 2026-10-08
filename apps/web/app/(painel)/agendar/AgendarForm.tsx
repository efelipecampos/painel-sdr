"use client";

// Tela Agendar, conforme design/Agendar.dc.html: à esquerda o lead e o convite; à direita a grade da semana,
// o ajuste de início e duração (a agenda é conferida a cada mudança) e a confirmação. O closer só aparece
// depois de confirmar (regra do closer às cegas).
import Link from "next/link";
import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { pedirTroca } from "../reunioes/actions";
import { buscarLeads, carregarLead, conferir, confirmar, horariosSemana, semanas, type LeadLoaded, type LeadResult } from "./actions";
import type { DiaGrade } from "@/lib/slots";

export interface CarouselOption {
  id: string; brand: "poli" | "chatshub"; name: string; description: string | null; durations: number[];
  suggest_min_users: number | null; suggest_max_users: number | null;
}

const BRAND = { poli: "Poli", chatshub: "ChatsHub" } as const;
const STATUS: Record<string, string> = { agendada: "Agendada", validada: "Validada", noshow: "No show", invalidada: "Invalidada", cancelada: "Cancelada" };
const DIAS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
const dayLabel = (d: string) => `${DIAS[new Date(`${d}T12:00:00Z`).getUTCDay()]} ${d.slice(8, 10)}/${d.slice(5, 7)}`;
const fmtWhen = (iso: string) => new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const closersLabel = (n: number) => (n === 1 ? "1 closer disponível" : `${n} closers disponíveis`);
const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const fmtMin = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const looksLikeHubspot = (q: string) => /^\s*\d{3,20}\s*$/.test(q) || /hubspot\.com/.test(q);

const Chevron = ({ left }: { left?: boolean }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={left ? "M15 6l-6 6l6 6" : "M9 6l6 6l-6 6"} />
  </svg>
);

export function AgendarForm({ carousels, initialLead, sdrs }: {
  carousels: CarouselOption[]; initialLead: string | null; sdrs: { id: string; name: string }[] | null;
}) {
  const [, start] = useTransition();
  const [loading, setLoading] = useState(false);
  // 1. Lead e convite
  const [q, setQ] = useState("");
  const [results, setResults] = useState<LeadResult[] | null>(null);
  const [lead, setLead] = useState<LeadLoaded | null>(null);
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [guests, setGuests] = useState("");
  const [handoff, setHandoff] = useState("");
  const [brand, setBrand] = useState<"poli" | "chatshub">("poli");
  const [carouselId, setCarouselId] = useState("");
  const [sdrId, setSdrId] = useState("");
  // 2. Horário
  const [weeks, setWeeks] = useState<{ label: string; days: { day: string; closed: string | null }[] }[]>([]);
  const [weekIdx, setWeekIdx] = useState(0);
  const [grid, setGrid] = useState<DiaGrade[] | null>(null);
  const [gridLoading, setGridLoading] = useState(false);
  const [day, setDay] = useState("");
  const [startTime, setStartTime] = useState("");
  const [duration, setDuration] = useState(30);
  const [check, setCheck] = useState<{ erro: string | null; avisos: string[]; count: number } | null>(null);
  const [checking, setChecking] = useState(false);
  const [state, action, confirming] = useActionState(confirmar, {});
  // pedido de troca na tela de sucesso
  const [swap, setSwap] = useState<"idle" | "form" | "sent" | "blocked">("idle");
  const [swapReason, setSwapReason] = useState("");
  const [swapMsg, setSwapMsg] = useState("");

  const info = lead?.info;
  const carousel = carousels.find((c) => c.id === carouselId);
  const ids = { leadId: lead?.leadId ?? null, contactId: info?.contactId ?? null };
  const ok = state.ok;

  const load = (input: { leadId?: string; ref?: string }) => start(async () => {
    setLoading(true);
    const r = await carregarLead(input);
    setLoading(false);
    setLead(r);
    setResults(null);
    setEmail(r.info?.email ?? "");
    setCompany(r.info?.company ?? "");
    const sug = r.sugestao?.[brand] ?? r.sugestao?.poli ?? null;
    if (sug) {
      const c = carousels.find((x) => x.id === sug)!;
      setBrand(c.brand);
      setCarouselId(c.id);
    } else if (r.info && !carouselId) {
      setCarouselId(carousels.find((c) => c.brand === brand)?.id ?? "");
    }
  });

  useEffect(() => {
    if (initialLead) load({ leadId: initialLead });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialLead]);

  // busca entre os leads do SDR enquanto digita (link/ID do HubSpot só no botão Buscar)
  useEffect(() => {
    if (q.trim().length < 2 || looksLikeHubspot(q)) { setResults(null); return; }
    const t = setTimeout(() => { buscarLeads(q).then(setResults).catch(() => setResults([])); }, 300);
    return () => clearTimeout(t);
  }, [q]);

  // carrossel mudou: semanas da janela dele
  useEffect(() => {
    setWeeks([]); setGrid(null); setDay(""); setStartTime(""); setCheck(null); setWeekIdx(0);
    if (!carouselId || !info) return;
    semanas(carouselId).then((w) => {
      setWeeks(w);
      // primeira semana com algum dia aberto
      setWeekIdx(Math.max(0, w.findIndex((x) => x.days.some((d) => !d.closed))));
    }).catch(() => setWeeks([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [carouselId, info?.contactId]);

  // semana ou duração mudou: grade com a contagem de closers
  const week = weeks[weekIdx];
  useEffect(() => {
    if (!week || !carouselId) { setGrid(null); return; }
    let alive = true;
    setGridLoading(true);
    horariosSemana({ carouselId, ...ids, days: week.days, duration })
      .then((g) => { if (alive) setGrid(g); })
      .catch(() => { if (alive) setGrid([]); })
      .finally(() => { if (alive) setGridLoading(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekIdx, weeks, duration]);

  // início, duração ou dia mudou: confere a agenda real para o intervalo exato
  const seq = useRef(0);
  useEffect(() => {
    if (!day || !/^\d{2}:\d{2}$/.test(startTime) || !carouselId) { setCheck(null); return; }
    const my = ++seq.current;
    setChecking(true);
    const t = setTimeout(() => {
      conferir({ carouselId, ...ids, local: `${day}T${startTime}`, duration })
        .then((r) => { if (my === seq.current) setCheck({ erro: r.erro, avisos: r.avisos, count: r.count }); })
        .finally(() => { if (my === seq.current) setChecking(false); });
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day, startTime, duration, carouselId]);

  const search = () => {
    if (looksLikeHubspot(q)) load({ ref: q, leadId: lead?.leadId ?? undefined });
    else if (q.trim().length >= 2) buscarLeads(q).then(setResults).catch(() => setResults([]));
  };

  const endMin = startTime ? toMin(startTime) + duration : 0;
  const ready = !!info && !!company.trim() && !!carousel && !!day && !!check && !check.erro && check.count > 0 && !checking && (!sdrs || !!sdrId);
  const summary = day && startTime && check && !check.erro && check.count > 0
    ? `${dayLabel(day)}, ${startTime}–${fmtMin(endMin)} · ${company.trim() || "…"} · ${BRAND[brand]}, ${carousel?.name ?? ""}`
    : "Escolha um horário para continuar";
  const hsHint = info ? "Lead carregado com os dados do HubSpot. Você não precisa colar nada."
    : "Busque entre os seus leads pelo nome ou telefone. Link ou ID do HubSpot só se o lead não aparecer.";

  const reset = () => {
    window.location.href = "/agendar";
  };

  return (
    <div className="ag-layout">
      {/* 1. Lead e convite */}
      <section className="card" style={{ gap: 16 }} aria-labelledby="sec-lead">
        <h2 id="sec-lead" className="card-title">1. Lead e convite</h2>

        <div className="ag-field">
          <label htmlFor="hs" className="ag-label">{info ? "Trocar de lead" : "Lead"}</label>
          <div style={{ display: "flex", gap: 8 }}>
            <input id="hs" className="field" style={{ flex: 1, minWidth: 0 }} value={q} onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); search(); } }}
              placeholder="Nome ou telefone do lead (ou link/ID do HubSpot)" />
            <button type="button" className="ag-chip" style={{ fontWeight: 600 }} onClick={search} disabled={loading}>Buscar</button>
          </div>
          <span className="ag-hint">{loading ? "Consultando o HubSpot…" : hsHint}</span>
          {results && (
            <div className="ag-box" style={{ gap: 4 }}>
              {results.length === 0 && <span className="ag-hint">Nenhum lead seu com esse nome ou telefone. Cole o link ou o ID do HubSpot.</span>}
              {results.map((r) => (
                <button key={r.lead_id} type="button" className="btn small" style={{ justifyContent: "flex-start", border: "none" }} onClick={() => { setQ(""); load({ leadId: r.lead_id }); }}>
                  {r.name ?? "Sem nome"}{r.company ? ` · ${r.company}` : ""}{r.phone_final ? ` · final ${r.phone_final}` : ""}
                </button>
              ))}
            </div>
          )}
          {lead?.erro && <div className="alert" role="alert">{lead.erro}</div>}
        </div>

        {info && (
          <div className="ag-box" style={{ gap: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div className="ag-icon">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M4 20V6l8-3l8 3v14M9 20v-5h6v5M9 9h.01M15 9h.01M9 12h.01M15 12h.01" />
                </svg>
              </div>
              <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
                <span style={{ fontSize: 14, lineHeight: "22px", fontWeight: 600 }}>{company.trim() || info.company || "Empresa não informada"}</span>
                <span className="ag-hint">{info.name ?? "Sem nome"} · dados trazidos do HubSpot</span>
              </div>
              <button type="button" className="btn small" onClick={() => { setLead(null); setCarouselId(""); setQ(""); }}>Trocar lead</button>
            </div>
            <dl className="ag-dl">
              <div><dt>Telefone</dt><dd>{info.phone ?? "—"}</dd></div>
              <div><dt>Site</dt><dd style={{ overflowWrap: "anywhere" }}>{info.website ?? "—"}</dd></div>
              <div><dt>Usuários informados</dt><dd>{info.users ?? "—"}</dd></div>
              <div><dt>Dono no HubSpot</dt><dd>{info.ownerName ?? "—"}{info.ownerIsMe ? " (você)" : ""}</dd></div>
              <div><dt>Etapa do Lead</dt><dd>{info.stageLabel ?? "—"}</dd></div>
            </dl>
            {lead?.reunioes && lead.reunioes.length > 0 && (
              <div role="status" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span className="ag-warn">Reuniões já agendadas com este lead</span>
                {lead.reunioes.map((r) => (
                  <span key={r.id} className="ag-hint">{fmtWhen(r.starts_at)} · {STATUS[r.status] ?? r.status} · {r.carousel ?? "—"} · closer {r.closer ?? "—"} · SDR {r.sdr ?? "—"}</span>
                ))}
              </div>
            )}
          </div>
        )}

        {info && (
          <>
            <div className="ag-field">
              <label htmlFor="email" className="ag-label">E-mail do lead</label>
              <input id="email" type="email" className="field" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email@empresa.com.br" />
              <span className="ag-hint">Veio do HubSpot; confira com o lead. Sem e-mail, você envia o link da reunião pelo WhatsApp.</span>
            </div>

            <div className="ag-box">
              <span id="lbl-brand" className="ag-label">Empresa</span>
              <div role="group" aria-labelledby="lbl-brand" style={{ display: "flex", gap: 8 }}>
                {(["poli", "chatshub"] as const).map((b) => (
                  <button key={b} type="button" className="ag-chip" aria-pressed={brand === b}
                    onClick={() => { setBrand(b); setCarouselId(lead?.sugestao?.[b] ?? carousels.find((c) => c.brand === b)?.id ?? ""); }}>{BRAND[b]}</button>
                ))}
              </div>
              <label htmlFor="carousel" className="ag-label">Carrossel (tamanho do cliente)</label>
              <select id="carousel" className="field" value={carouselId} onChange={(e) => setCarouselId(e.target.value)}>
                {carousels.filter((c) => c.brand === brand).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <span className="ag-hint">
                {lead?.sugestao?.[brand] && lead.sugestao[brand] === carouselId
                  ? `Sugerido pelos ${info.users} usuários informados no HubSpot. Troque se o lead disser outro tamanho.`
                  : carousel?.description || "Escolha pelo tamanho do cliente."}
              </span>
            </div>

            <div className="ag-field">
              <label htmlFor="company" className="ag-label">Nome da empresa do lead</label>
              <input id="company" className="field" value={company} maxLength={120} onChange={(e) => setCompany(e.target.value)} placeholder="Preencha se o HubSpot não tiver" />
              <span className="ag-hint">Título do convite: <strong style={{ color: "var(--text-primary)" }}>Apresentação {BRAND[brand]} - {company.trim() || "…"}</strong></span>
            </div>

            <div className="ag-field">
              <label htmlFor="guests" className="ag-label">Outros convidados (e-mails separados por vírgula)</label>
              <input id="guests" className="field" value={guests} onChange={(e) => setGuests(e.target.value)} placeholder="socio@empresa.com.br" />
            </div>

            {sdrs && (
              <div className="ag-field">
                <label htmlFor="sdr" className="ag-label">SDR responsável</label>
                <select id="sdr" className="field" value={sdrId} onChange={(e) => setSdrId(e.target.value)}>
                  <option value="">Escolha…</option>
                  {sdrs.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
            )}

            <div className="ag-field">
              <label htmlFor="notes" className="ag-label">Passagem de bastão para o closer</label>
              <textarea id="notes" rows={4} className="field" style={{ resize: "vertical", lineHeight: "22px" }} maxLength={4000} value={handoff} onChange={(e) => setHandoff(e.target.value)}
                placeholder="O que o closer precisa saber antes da reunião: a dor do lead, tamanho da operação, quem decide, o que já foi combinado..." />
              <span className="ag-hint">Só a equipe vê. O lead não vê esse texto no convite.</span>
            </div>
          </>
        )}
      </section>

      <div className="ag-col">
        {!ok && (
          <>
            {/* 2. Horário */}
            <section className="card" style={{ gap: 16 }} aria-labelledby="sec-slot">
              <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <h2 id="sec-slot" className="card-title">2. Horário</h2>
                <span className="ag-hint">{carousel && info ? `Horários livres para ${BRAND[brand]}, ${carousel.name} · Brasília` : "Escolha o lead e o carrossel para ver os horários."}</span>
                <span className="spacer" />
                {week && (
                  <>
                    <button type="button" className="ag-arrow" aria-label="Semana anterior" disabled={weekIdx === 0} onClick={() => setWeekIdx(weekIdx - 1)}><Chevron left /></button>
                    <span style={{ fontWeight: 500 }}>{week.label}</span>
                    <button type="button" className="ag-arrow" aria-label="Próxima semana" disabled={weekIdx >= weeks.length - 1} onClick={() => setWeekIdx(weekIdx + 1)}><Chevron /></button>
                  </>
                )}
              </div>

              {week && (
                <div className="ag-week" aria-busy={gridLoading}>
                  {(grid ?? week.days.map((d) => ({ day: d.day, label: dayLabel(d.day), closed: d.closed, slots: [] }))).map((d) => (
                    <div key={d.day} className="ag-day">
                      <div className="ag-day-h">{d.label}</div>
                      {gridLoading && !d.closed && <span className="ag-hint">Consultando as agendas…</span>}
                      {!gridLoading && d.closed && <span className="ag-hint">{d.closed}</span>}
                      {!gridLoading && !d.closed && d.slots.length === 0 && <span className="ag-hint">Nenhum closer livre neste dia.</span>}
                      {!gridLoading && d.slots.map((s) => {
                        const on = day === d.day && startTime === s.start;
                        return (
                          <button key={s.start} type="button" className="ag-slot" aria-pressed={on} onClick={() => { setDay(d.day); setStartTime(s.start); }}>
                            <span>{s.start}</span><span>{closersLabel(s.count)}</span>
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </div>
              )}

              {day && (
                <div className="ag-adjust">
                  <div className="ag-field">
                    <label htmlFor="start" className="ag-label">Início</label>
                    <input id="start" type="time" step={300} className="field" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
                  </div>
                  <div className="ag-field">
                    <span id="lbl-dur" className="ag-label">Duração</span>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <div role="group" aria-labelledby="lbl-dur" style={{ display: "flex", gap: 8 }}>
                        {(carousel?.durations ?? [30, 45, 60]).map((m) => (
                          <button key={m} type="button" className="ag-chip" aria-pressed={duration === m} onClick={() => setDuration(m)}>{m} min</button>
                        ))}
                      </div>
                      <label htmlFor="dur" className="sr-only">Duração em minutos</label>
                      <input id="dur" type="number" min={10} max={240} step={5} className="field" style={{ width: 76 }} value={duration}
                        onChange={(e) => setDuration(Math.max(10, Math.min(240, Number(e.target.value) || 30)))} />
                      <span>min</span>
                    </div>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }} aria-live="polite">
                    <span className="ag-label">Ajuste à vontade. A agenda é conferida a cada mudança.</span>
                    <span style={{ fontSize: 14, lineHeight: "22px", fontWeight: 600 }}>{startTime ? `${dayLabel(day)}, ${startTime} às ${fmtMin(endMin)}` : "Informe o início"}</span>
                    {checking ? <span className="ag-hint">Conferindo a agenda…</span>
                      : check?.erro ? <span className="ag-warn">{check.erro}</span>
                      : check && <span className={check.count === 0 ? "ag-warn" : undefined} style={{ fontSize: 12, lineHeight: "16px", fontWeight: 500 }}>
                          {check.count === 0 ? "Nenhum closer disponível nesse intervalo. Mude o início ou a duração." : closersLabel(check.count)}
                        </span>}
                    {!checking && check && !check.erro && check.avisos.length > 0 && (
                      <span className="ag-warn">{check.avisos.map((a) => `${a}.`).join(" ")} Fica marcado para os gestores.</span>
                    )}
                  </div>
                </div>
              )}
            </section>

            {/* Confirmação */}
            <form action={action} className="card" style={{ flexDirection: "row", alignItems: "center", gap: 16 }} aria-label="Confirmação">
              <input type="hidden" name="carouselId" value={carouselId} />
              <input type="hidden" name="local" value={day && startTime ? `${day}T${startTime}` : ""} />
              <input type="hidden" name="duration" value={duration} />
              <input type="hidden" name="email" value={email} />
              <input type="hidden" name="company" value={company} />
              <input type="hidden" name="guests" value={guests} />
              <input type="hidden" name="handoff" value={handoff} />
              <input type="hidden" name="leadId" value={lead?.leadId ?? ""} />
              <input type="hidden" name="contactId" value={info?.contactId ?? ""} />
              <input type="hidden" name="sdrId" value={sdrId} />
              <div style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1 }}>
                <span style={{ fontSize: 14, lineHeight: "22px", fontWeight: 600 }}>{summary}</span>
                <span className="ag-hint">O closer é definido pelo carrossel e só aparece depois que você confirmar. Ao confirmar, o sistema cria o evento com Google Meet e envia o convite ao lead.</span>
                {info && !company.trim() && <span className="ag-warn">Preencha o nome da empresa do lead.</span>}
                {sdrs && info && !sdrId && <span className="ag-warn">Escolha o SDR responsável.</span>}
                {state.erro && <span role="alert" style={{ color: "var(--danger)" }}>{state.erro}</span>}
              </div>
              <button type="submit" className={`btn${ready ? " primary" : ""}`} style={{ height: 44, padding: "0 24px", fontWeight: 600 }} disabled={!ready || confirming}>
                {confirming ? "Agendando…" : "Agendar"}
              </button>
            </form>
          </>
        )}

        {ok && (
          <section className="card ag-done" aria-labelledby="sec-done">
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div className="ag-check">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12l5 5l9-10" /></svg>
              </div>
              <div style={{ display: "flex", flexDirection: "column" }}>
                <h2 id="sec-done" style={{ margin: 0, fontSize: 18, lineHeight: "24px", fontWeight: 700 }}>Reunião agendada</h2>
                <span>{ok.quando}</span>
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 16 }}>
              <div className="ag-box" style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
                <div className="ag-avatar">{ok.closerIni}</div>
                <div style={{ display: "flex", flexDirection: "column" }}>
                  <span className="ag-hint">Closer</span>
                  <span style={{ fontSize: 14, lineHeight: "22px", fontWeight: 600 }}>{ok.closer}</span>
                </div>
              </div>
              <div className="ag-box" style={{ justifyContent: "center" }}>
                <span className="ag-hint">Link da reunião</span>
                <span style={{ fontSize: 14, lineHeight: "22px", fontWeight: 600 }}>No convite, na sua agenda do Google</span>
              </div>
            </div>
            <p style={{ margin: 0 }}>{email ? "Convite enviado ao lead." : "O lead não tem e-mail: copie o link do Meet na sua agenda e mande pelo WhatsApp."}</p>
            {ok.aviso && <p className="ag-warn" style={{ margin: 0 }}>Fora do horário padrão: {ok.aviso}. Fica marcado para os gestores.</p>}
            <p className="ag-hint" style={{ margin: 0 }}>Se precisar mudar o horário, use Mudar horário em Reuniões: a reunião continua com o mesmo closer, se ele estiver livre. Cancelar e agendar de novo para o mesmo lead também mantém o closer.</p>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <Link href="/reunioes" className="btn primary" style={{ fontWeight: 600 }}>Ver minhas reuniões</Link>
              <button type="button" className="btn" onClick={reset}>Agendar outra</button>
              <Link href={`/reuniao/${ok.meetingId}`} className="btn">Ver passagem de bastão</Link>
              <span className="spacer" />
              {swap === "idle" && !sdrs && <button type="button" className="btn" onClick={() => setSwap("form")}>Pedir troca de closer</button>}
            </div>
            {swap === "form" && (
              <div style={{ borderTop: "1px solid var(--border-card)", paddingTop: 16, display: "flex", flexDirection: "column", gap: 8 }}>
                <label htmlFor="swap-reason" className="ag-label">Por que esta reunião precisa de outro closer? O pedido vai para o gestor de SDR aprovar. Você não escolhe o novo closer.</label>
                <div style={{ display: "flex", gap: 8 }}>
                  <input id="swap-reason" className="field" style={{ flex: 1, minWidth: 0 }} value={swapReason} onChange={(e) => setSwapReason(e.target.value)}
                    placeholder="Ex.: o lead pediu para falar com quem o atendeu da última vez" />
                  <button type="button" className="btn primary" style={{ fontWeight: 600 }} disabled={!swapReason.trim()}
                    onClick={() => start(async () => {
                      const r = await pedirTroca(ok.meetingId, swapReason);
                      if (r.semOutro) { setSwapMsg(r.erro ?? ""); setSwap("blocked"); }
                      else if (r.erro) setSwapMsg(r.erro);
                      else setSwap("sent");
                    })}>Enviar pedido</button>
                  <button type="button" className="btn" onClick={() => { setSwap("idle"); setSwapReason(""); setSwapMsg(""); }}>Desistir</button>
                </div>
                {swapMsg && <span role="alert" style={{ color: "var(--danger)" }}>{swapMsg}</span>}
              </div>
            )}
            {swap === "sent" && (
              <p style={{ margin: 0, borderTop: "1px solid var(--border-card)", paddingTop: 16 }}>
                <span className="ag-pill">Troca pedida</span>Aguardando o gestor de SDR. A reunião continua com o closer atual até ele decidir.
              </p>
            )}
          </section>
        )}
      </div>

      {swap === "blocked" && (
        <div className="modal-backdrop">
          <div role="alertdialog" aria-modal="true" aria-labelledby="dlg-title" aria-describedby="dlg-desc" className="modal">
            <h2 id="dlg-title">Não há outro closer nesse horário</h2>
            <p id="dlg-desc" style={{ margin: 0, lineHeight: "22px" }}>{swapMsg}</p>
            <p className="ag-hint" style={{ margin: 0 }}>Se a reunião precisar mesmo de outro closer, fale com o gestor de SDR: só ele ou outro gestor pode mudar o horário e o closer juntos.</p>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button type="button" className="btn primary" autoFocus onClick={() => { setSwap("idle"); setSwapReason(""); setSwapMsg(""); }}>Entendi</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
