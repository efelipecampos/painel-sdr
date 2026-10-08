"use client";

import { setUserActive } from "./actions";

// Interruptor "Ativo" (design/Usuarios.dc.html). Envia o formulário de desativar/reativar.
export function ActiveSwitch({ sdrId, profileId, active, name, locked }: { sdrId: string | null; profileId: string | null; active: boolean; name: string; locked: boolean }) {
  return (
    <form action={setUserActive} onSubmit={(e) => {
      if (active && !confirm(`Desativar ${name}? Perde o acesso na hora e sai das listas e carrosséis. Nenhum dado é apagado.`)) e.preventDefault();
    }}>
      <input type="hidden" name="sdr_id" value={sdrId ?? ""} />
      <input type="hidden" name="profile_id" value={profileId ?? ""} />
      <input type="hidden" name="active" value={active ? "false" : "true"} />
      <button type="submit" role="switch" aria-checked={active} aria-label={`${name} ativo`} className="switch-btn" disabled={locked}
        title={locked ? "Você e o administrador não podem ser desativados aqui." : undefined}><span /></button>
    </form>
  );
}
