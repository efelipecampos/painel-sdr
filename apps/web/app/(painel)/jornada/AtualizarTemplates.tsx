"use client";

// Botão "Atualizar templates" no cabeçalho da Jornada (pedido do Felipe, 2026-10-30): o worker só copia a lista do
// Poli a cada 30 min, e template recém-criado não aparecia na busca.
import { useState, useTransition } from "react";
import { atualizarTemplates } from "./actions";
import s from "./jornada.module.css";

export function AtualizarTemplates({ ultima }: { ultima: string | null }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; msg: string } | null>(null);
  return (
    <div className={s.tplSync}>
      <span className={msg && !msg.ok ? s.msgErr : s.msg} role="status">
        {pending ? "Buscando no Poli (leva uns 15 s)..." : msg ? msg.msg : ultima ? `Templates do Poli atualizados às ${ultima}` : ""}
      </span>
      <button type="button" disabled={pending} className={s.smallBtn}
        onClick={() => start(async () => setMsg(await atualizarTemplates()))}>
        {pending ? "Atualizando..." : "Atualizar templates"}
      </button>
    </div>
  );
}
