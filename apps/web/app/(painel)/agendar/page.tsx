import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient, getMe, isManager } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { AgendarForm, type CarouselOption } from "./AgendarForm";

export const metadata = { title: "Agendar reunião — Painel SDR" };

export default async function AgendarPage({ searchParams }: { searchParams: Promise<{ lead?: string; voltar?: string }> }) {
  const me = await getMe();
  if (!me || !(me.role === "sdr" || isManager(me))) redirect("/");
  const sp = await searchParams;
  const db = (await createClient()).schema("painel");
  const [cars, sdrs] = await Promise.all([
    db.rpc("carrosseis_para_agendar"),
    // SDRs com login ativo (para o campo "SDR responsável"). Lido no servidor: a função usuarios() é só de quem
    // gerencia usuários, e o gestor que agenda (Iago) não tem essa marcação.
    isManager(me)
      ? createAdminClient().schema("painel").from("profiles").select("name, sdr_id").eq("role", "sdr").eq("active", true).order("name")
      : Promise.resolve({ data: [] }),
  ]);
  if (cars.error) throw new Error(`Não foi possível ler os carrosséis: ${cars.error.message}`);
  const sdrOptions = ((sdrs.data ?? []) as { sdr_id: string | null; name: string }[])
    .filter((u) => u.sdr_id)
    .map((u) => ({ id: u.sdr_id!, name: u.name }));
  // Volta para a lista do SDR de onde veio (com filtros e página); só aceita /sdr/..., nunca outro site.
  const voltar = sp.voltar && /^\/sdr\/[0-9a-f-]+(\?.*)?$/i.test(sp.voltar) ? sp.voltar : null;
  const backHref = voltar ?? (me.role === "sdr" ? `/sdr/${me.sdrId}` : "/");
  const backLabel = voltar || me.role === "sdr" ? (me.role === "sdr" ? "Voltar aos meus chats" : "Voltar à lista do SDR") : "Voltar ao painel";
  return (
    <main className="page">
      <div className="page-head">
        <Link href={backHref} className="ag-back" aria-label={backLabel}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 6l-6 6l6 6" /></svg>
        </Link>
        <h1 className="title">Agendar reunião</h1>
      </div>
      <AgendarForm carousels={(cars.data ?? []) as CarouselOption[]} initialLead={sp.lead ?? null} voltar={voltar} sdrs={isManager(me) ? sdrOptions : null} />
    </main>
  );
}
