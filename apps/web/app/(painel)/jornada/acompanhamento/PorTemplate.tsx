"use client";

// Jornada · Acompanhamento, "Por template" (2026-10-16): o gestor escolhe um template na busca e vê o resultado dele no
// período, por quem enviou e por dia. As contas são do banco (painel.template_resultado); 24 h para resposta e agendamento.
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { TemplateBusca } from "../TemplateBusca";
import type { TemplateOpcao } from "../RegrasView";
import s from "../jornada.module.css";

export interface LinhaTemplate { dia: string; quem: string; receberam: number; responderam: number; so_automatica: number; agendaram: number; fora_das_sdrs: number }

const n = (x: number) => x.toLocaleString("pt-BR");
const pct = (a: number, b: number) => (b ? `${(a / b * 100).toFixed(1).replace(".", ",")}%` : "—");
const diaBR = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

export function PorTemplate({ templates, escolhido, linhas }: { templates: TemplateOpcao[]; escolhido: string | null; linhas: LinhaTemplate[] | null }) {
  const router = useRouter();
  const path = usePathname();
  const params = useSearchParams();
  const escolher = (uuid: string) => {
    const q = new URLSearchParams(params.toString());
    q.set("template", uuid);
    router.push(`${path}?${q.toString()}`);
  };
  const tot = (linhas ?? []).reduce((a, l) => ({
    receberam: a.receberam + l.receberam, responderam: a.responderam + l.responderam, so_automatica: a.so_automatica + l.so_automatica,
    agendaram: a.agendaram + l.agendaram, fora_das_sdrs: a.fora_das_sdrs + l.fora_das_sdrs,
  }), { receberam: 0, responderam: 0, so_automatica: 0, agendaram: 0, fora_das_sdrs: 0 });

  const celulas = (l: Omit<LinhaTemplate, "dia" | "quem">) => (
    <>
      <td className={s.right}>{n(l.receberam)}</td>
      <td className={s.right}><div className={s.today}><b>{n(l.responderam)}</b><span className={s.fails}>{pct(l.responderam, l.receberam)}</span></div></td>
      <td className={s.right}><div className={s.today}><b>{n(l.so_automatica)}</b><span className={s.fails}>{pct(l.so_automatica, l.receberam)}</span></div></td>
      <td className={s.right}><div className={s.today}><b>{n(l.agendaram)}</b><span className={s.fails}>{pct(l.agendaram, l.receberam)}</span></div></td>
      <td className={s.right}><span className={l.fora_das_sdrs ? s.failsOn : s.fails}>{l.fora_das_sdrs ? n(l.fora_das_sdrs) : "nenhum"}</span></td>
    </>
  );

  return (
    <section aria-labelledby="sec-tpl" className={`${s.card} ${s.cardAberto}`}>
      <div className={s.cardHead}>
        <div>
          <h2 id="sec-tpl" className={s.h2}>Por template</h2>
          <span className={s.note}>Escolha um template para ver quem recebeu, quem respondeu e quem agendou em até 24 h depois do envio. Resposta automática (robô do lead) não conta como resposta.</span>
        </div>
      </div>
      <div style={{ padding: "0 16px 16px", maxWidth: 560 }}>
        <TemplateBusca id="f-tpl-acomp" rotulo="Template" lista={templates} valor={escolhido ?? ""} onEscolher={escolher} />
      </div>
      {escolhido && linhas && (
        <table className={s.table}>
          <thead>
            <tr>
              <th scope="col">Enviado por</th>
              <th scope="col">Dia</th>
              <th scope="col" className={s.right}>Receberam</th>
              <th scope="col" className={s.right}>Responderam de verdade</th>
              <th scope="col" className={s.right}>Só resposta automática</th>
              <th scope="col" className={s.right}>Agendaram</th>
              <th scope="col" className={s.right}>Responderam fora das SDRs</th>
            </tr>
          </thead>
          <tbody>
            {linhas.map((l) => (
              <tr key={`${l.dia}-${l.quem}`}>
                <td className={s.dest}>{l.quem}</td>
                <td>{diaBR(l.dia)}</td>
                {celulas(l)}
              </tr>
            ))}
            {linhas.length > 1 && (
              <tr className={s.rowOn}>
                <td className={s.dest}>Total</td>
                <td />
                {celulas(tot)}
              </tr>
            )}
          </tbody>
        </table>
      )}
      {escolhido && linhas && !linhas.length && <div className={s.empty}>Esse template não foi enviado no período.</div>}
      {escolhido && linhas && tot.fora_das_sdrs > 0 && (
        <div className={s.legend}><span>&quot;Fora das SDRs&quot;: o lead respondeu num chat de gestor, closer ou sem dono. Nenhuma SDR vê essa resposta; distribua no Poli.</span></div>
      )}
    </section>
  );
}
