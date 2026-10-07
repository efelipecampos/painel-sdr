import { redirect } from "next/navigation";
import { PeriodFilter } from "@/components/PeriodFilter";
import { createClient, getMe, isManager } from "@/lib/supabase/server";
import { resolvePeriod } from "@/lib/time";

export const metadata = { title: "Relatório de agendamentos — Painel SDR" };

interface Row { sdr_id: string; sdr: string; agendadas: number; canceladas_1h: number; reagendadas_1h: number; pedidos: number; aprovados: number; recusados: number }

// Sinal de tentativa de burlar o carrossel (docs/agendamento.md, seção 5): cancelar ou reagendar logo depois de
// ver o closer, e pedidos de troca. Período pela data em que a reunião foi agendada.
export default async function RelatorioPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const me = await getMe();
  if (!isManager(me)) redirect("/");
  const sp = await searchParams;
  const period = resolvePeriod({ periodo: sp.periodo ?? "7d", de: sp.de, ate: sp.ate });
  const { data, error } = await (await createClient()).schema("painel").rpc("relatorio_agendamentos", { p_from: period.from.toISOString(), p_to: period.to.toISOString() });
  if (error) throw new Error(`Não foi possível ler o relatório: ${error.message}`);
  const rows = (data ?? []) as Row[];
  return (
    <main className="page">
      <div className="page-head"><h1 className="title">Relatório de agendamentos</h1></div>
      <PeriodFilter current={period.key} fromLocal={period.fromLocal} toLocal={period.toLocal} />
      <p className="muted" style={{ margin: 0 }}>Reuniões agendadas pelo painel no período, por SDR. Cancelar ou mudar o horário em até 1 hora depois de agendar, e pedir troca de closer, podem indicar tentativa de escolher o closer.</p>
      <div className="card">
        <div className="table-wrap">
          <table>
            <thead><tr>
              <th scope="col">SDR</th><th scope="col">Agendadas</th><th scope="col">Canceladas em até 1 h</th><th scope="col">Horário mudado em até 1 h</th>
              <th scope="col">Pedidos de troca</th><th scope="col">Aprovados</th><th scope="col">Recusados</th>
            </tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={7} className="muted">Nenhuma reunião agendada pelo painel neste período.</td></tr>}
              {rows.map((r) => (
                <tr key={r.sdr_id}>
                  <td>{r.sdr}</td><td>{r.agendadas}</td><td>{r.canceladas_1h}</td><td>{r.reagendadas_1h}</td>
                  <td>{r.pedidos}</td><td>{r.aprovados}</td><td>{r.recusados}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
