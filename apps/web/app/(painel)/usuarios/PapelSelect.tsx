"use client";

import { definirPapel } from "./actions";

const PAPEL: Record<string, string> = { admin: "Admin", gestor: "Gestor", sdr: "SDR", closer: "Closer" };

// Papel na linha da lista: trocar pede confirmação e salva na hora.
export function PapelSelect({ sdrId, profileId, papel, name, opcoes, locked }: {
  sdrId: string | null; profileId: string | null; papel: string; name: string; opcoes: string[]; locked: boolean;
}) {
  if (locked) return <>{PAPEL[papel] ?? papel}</>;
  return (
    <form action={definirPapel}>
      <input type="hidden" name="sdr_id" value={sdrId ?? ""} />
      <input type="hidden" name="profile_id" value={profileId ?? ""} />
      <select name="papel" defaultValue={papel} className="field" aria-label={`Papel de ${name}`} style={{ height: 32 }}
        onChange={(e) => {
          if (confirm(`Mudar ${name} para ${PAPEL[e.target.value]}? O acesso muda na hora.`)) e.target.form?.requestSubmit();
          else e.target.value = papel;
        }}>
        {opcoes.map((p) => <option key={p} value={p}>{PAPEL[p]}</option>)}
      </select>
    </form>
  );
}
