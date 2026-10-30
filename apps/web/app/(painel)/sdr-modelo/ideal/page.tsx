import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient, getMe, isManager } from "@/lib/supabase/server";
import type { Comportamento } from "@/lib/sdr-modelo";
import { formatDateTime } from "@/lib/time";
import { IdealForm, type Historico } from "./IdealForm";
import s from "../modelo.module.css";

export const metadata = { title: "SDR Ideal — Painel SDR" };

interface V { versao: number; created_at: string; created_by: string | null; origem: string; mudancas: string[]; comportamentos: Comportamento[] }

// Fase 9b: configuração do SDR Ideal (design/SDRIdeal.dc.html). Só gestor e admin.
export default async function SdrIdealPage() {
  const me = await getMe();
  if (!isManager(me)) redirect("/");
  const db = (await createClient()).schema("painel");
  const { data, error } = await db.from("sdr_ideal_versoes").select("versao, created_at, created_by, origem, mudancas, comportamentos").order("versao", { ascending: false });
  if (error) throw new Error(`Não foi possível ler o SDR Ideal: ${error.message}`);
  const versoes = (data ?? []) as V[];
  const autores = [...new Set(versoes.map((v) => v.created_by).filter((x): x is string => !!x))];
  const nomes = new Map<string, string>();
  if (autores.length) {
    const p = await db.from("profiles").select("id, name").in("id", autores);
    for (const r of (p.data ?? []) as { id: string; name: string }[]) nomes.set(r.id, r.name);
  }
  const historico: Historico[] = versoes.map((v, i) => ({
    versao: v.versao,
    quando: i === 0 ? `desde ${formatDateTime(v.created_at)}` : `${formatDateTime(v.created_at)} a ${formatDateTime(versoes[i - 1].created_at)}`,
    quem: v.created_by ? (nomes.get(v.created_by) ?? "—") : v.origem === "inicial" ? "Sistema (3 melhores SDRs)" : "Sistema",
    mudancas: v.mudancas,
  }));
  const atual = versoes[0];

  return (
    <main className={s.page}>
      <div className={s.head} style={{ alignItems: "center" }}>
        <Link href="/sdr-modelo" aria-label="Voltar para a visão do time" className={s.back}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 6l-6 6l6 6" /></svg>
        </Link>
        <div className={s.headText}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <h1 className={s.h1}>SDR Ideal</h1>
            {atual && <span className="badge" style={{ border: "1px solid #4e5d7f", borderRadius: 9999, padding: "2px 10px", fontSize: 12, fontWeight: 600 }}>
              Versão {atual.versao} · desde {formatDateTime(atual.created_at)}
            </span>}
          </div>
          <p className={s.sub}>Os comportamentos, as faixas e os pesos que formam a aderência de cada SDR. Só gestores e admin editam.</p>
        </div>
      </div>
      {!atual
        ? <div className="card"><p className={s.empty}>Ainda não há versão do SDR Ideal.</p></div>
        : <IdealForm versao={atual.versao} comportamentos={atual.comportamentos} historico={historico} />}
    </main>
  );
}
