"use client";

// Status de reunião do lead. "Agendada" pode vir do HubSpot; admin e gestor marcam qualquer status à mão.
import { useTransition, useState } from "react";
import type { MeetingStatus } from "@painel/shared";
import { setMeetingStatus } from "./actions";

const OPTIONS: { value: MeetingStatus | ""; label: string }[] = [
  { value: "", label: "Sem reunião" },
  { value: "agendada", label: "Agendada" },
  { value: "validada", label: "Validada" },
  { value: "invalidada", label: "Invalidada" },
  { value: "noshow", label: "No show" },
  { value: "cancelada", label: "Cancelada" },
];

export function MeetingSelect({ leadId, leadName, status, origem }: {
  leadId: string; leadName: string; status: MeetingStatus | null; origem: "hubspot" | "manual" | null;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="cell-stack">
      <select className="field" style={{ height: 36, minWidth: 140, fontWeight: status ? 600 : 400, borderColor: status ? "var(--brand-500)" : undefined }}
        value={status ?? ""} disabled={pending} aria-label={`Status da reunião: ${leadName}`}
        onChange={(e) => {
          const v = e.target.value;
          setError(null);
          start(async () => {
            const r = await setMeetingStatus(leadId, v || null);
            if (r.error) setError(r.error);
          });
        }}>
        {OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <span className="muted">
        {error ?? (pending ? "Salvando..." : origem === "hubspot" ? "Via HubSpot" : origem === "manual" ? "Marcado à mão" : "")}
      </span>
    </div>
  );
}
