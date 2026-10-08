"use client";

import Link from "next/link";
import { useState } from "react";
import type { Settings } from "@/lib/data";
import { saveSettings } from "./actions";

const DAYS = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];
const ORDER = [1, 2, 3, 4, 5, 6, 0];

export interface Hour { weekday: number; enabled: boolean; start_time: string; end_time: string }
export interface Holiday { day: string; name: string }

export function SettingsForm({ hours, holidays, settings }: { hours: Hour[]; holidays: Holiday[]; settings: Settings }) {
  const [h, setH] = useState(hours);
  const [hol, setHol] = useState(holidays);
  const [newDay, setNewDay] = useState("");
  const [newName, setNewName] = useState("");
  const setHour = (wd: number, patch: Partial<Hour>) => setH(h.map((x) => (x.weekday === wd ? { ...x, ...patch } : x)));

  return (
    <form action={saveSettings} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <input type="hidden" name="hours" value={JSON.stringify(h)} />
      <input type="hidden" name="holidays" value={JSON.stringify(hol)} />

      <section className="card" aria-labelledby="hc">
        <h2 id="hc" className="card-title">Horário comercial</h2>
        <p className="muted" style={{ margin: 0 }}>Fuso America/Sao_Paulo (Brasília). Usado nos tempos de resposta e no limite de "parado".</p>
        {ORDER.map((wd) => {
          const x = h.find((y) => y.weekday === wd)!;
          return (
            <div key={wd} className="hours-row">
              <span>{DAYS[wd]}</span>
              <label className="switch">
                <input type="checkbox" checked={x.enabled} onChange={(e) => setHour(wd, { enabled: e.target.checked })} aria-label={`${DAYS[wd]} aberto`} />
                <span className="muted">{x.enabled ? "Aberto" : "Fechado"}</span>
              </label>
              <input type="time" className="field" value={x.start_time} disabled={!x.enabled}
                onChange={(e) => setHour(wd, { start_time: e.target.value })} aria-label={`${DAYS[wd]}: início`} />
              <span className="muted">até</span>
              <input type="time" className="field" value={x.end_time} disabled={!x.enabled}
                onChange={(e) => setHour(wd, { end_time: e.target.value })} aria-label={`${DAYS[wd]}: fim`} />
            </div>
          );
        })}
        <label className="switch">
          <input type="checkbox" name="holidays_off" defaultChecked={settings.holidays_off} />
          Tratar os feriados abaixo como fora do expediente
        </label>
      </section>

      <section className="card" aria-labelledby="fe">
        <h2 id="fe" className="card-title">Feriados</h2>
        {hol.length === 0 && <span className="muted">Nenhum feriado cadastrado.</span>}
        {hol.map((x) => (
          <div key={x.day} className="group">
            <span style={{ width: 110 }}>{x.day.split("-").reverse().join("/")}</span>
            <span style={{ flex: 1 }}>{x.name}</span>
            <button type="button" className="btn small" onClick={() => setHol(hol.filter((y) => y.day !== x.day))}>Remover</button>
          </div>
        ))}
        <div className="group">
          <input type="date" className="field" value={newDay} onChange={(e) => setNewDay(e.target.value)} aria-label="Data do feriado" />
          <input type="text" className="field" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Nome do feriado" aria-label="Nome do feriado" />
          <button type="button" className="btn small" disabled={!newDay || !newName.trim()} onClick={() => {
            setHol([...hol.filter((y) => y.day !== newDay), { day: newDay, name: newName.trim() }].sort((a, b) => a.day.localeCompare(b.day)));
            setNewDay(""); setNewName("");
          }}>Adicionar</button>
        </div>
      </section>

      <section className="card" aria-labelledby="tm">
        <h2 id="tm" className="card-title">Tempos de resposta</h2>
        <label className="switch">
          <input type="checkbox" name="metrics_business_only" defaultChecked={settings.metrics_business_only} />
          Medir 1ª resposta e tempo de resposta só com leads que escreveram no horário comercial
        </label>
        <p className="muted" style={{ margin: 0 }}>
          Marcado: lead que escreveu fora do expediente (à noite, no fim de semana) não entra na mediana. Desmarcado: entra toda mensagem do lead.
          Nos dois casos o tempo é o real que o lead esperou.
        </p>
      </section>

      <section className="card" aria-labelledby="ag">
        <h2 id="ag" className="card-title">Leads aguardando resposta</h2>
        <div className="group">
          <label className="lbl" htmlFor="stale">Destacar como parado depois de</label>
          <input id="stale" name="stale_minutes" type="number" min={1} max={1440} className="field" style={{ width: 90 }} defaultValue={settings.stale_minutes} />
          <span className="muted">minutos</span>
        </div>
        <label className="switch">
          <input type="checkbox" name="stale_business_only" defaultChecked={settings.stale_business_only} />
          Contar o tempo parado só em horário comercial
        </label>
      </section>

      <section className="card" aria-labelledby="ga">
        <h2 id="ga" className="card-title">Google Agenda</h2>
        <label className="lbl" htmlFor="google_archive_calendar_id">ID da agenda de arquivo</label>
        <input id="google_archive_calendar_id" name="google_archive_calendar_id" className="field"
          defaultValue={settings.google_archive_calendar_id} placeholder="…@group.calendar.google.com" />
        <p className="muted" style={{ margin: 0 }}>
          Reuniões canceladas e no show vão para essa agenda. No Google Agenda: Configurações da agenda "Arquivo de reuniões" → Integrar agenda → ID da agenda.
        </p>
        <label className="lbl" htmlFor="reuse_window">Uma reunião por lead: reagendar a reunião anterior (em vez de criar outra no HubSpot) quando ela foi</label>
        <select id="reuse_window" name="reuse_window" className="field" style={{ maxWidth: 420 }} defaultValue={settings.reuse_window}>
          <option value="mes">cancelada ou no show neste mês</option>
          <option value="30d">cancelada ou no show nos últimos 30 dias</option>
        </select>
        <p className="muted" style={{ margin: 0 }}>Reunião ainda agendada sempre é reagendada. Validada ou invalidada libera uma reunião nova.</p>
        <label className="switch">
          <input type="checkbox" name="google_invite_sdr" defaultChecked={settings.google_invite_sdr} />
          Convidar o SDR que agendou para o evento da reunião
        </label>
      </section>

      <div className="group">
        <span className="spacer" />
        <Link href="/" className="btn">Cancelar</Link>
        <button type="submit" className="btn primary">Salvar configurações</button>
      </div>
    </form>
  );
}
