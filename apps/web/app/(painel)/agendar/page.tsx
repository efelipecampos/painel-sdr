import { redirect } from "next/navigation";
import { createClient, getMe, isManager } from "@/lib/supabase/server";
import { AgendarForm, type CarouselOption } from "./AgendarForm";

export const metadata = { title: "Agendar reunião — Painel SDR" };

export default async function AgendarPage({ searchParams }: { searchParams: Promise<{ lead?: string }> }) {
  const me = await getMe();
  if (!me || !(me.role === "sdr" || isManager(me))) redirect("/");
  const sp = await searchParams;
  const db = (await createClient()).schema("painel");
  const [cars, sdrs] = await Promise.all([
    db.rpc("carrosseis_para_agendar"),
    isManager(me) ? db.rpc("usuarios") : Promise.resolve({ data: [] }),
  ]);
  if (cars.error) throw new Error(`Não foi possível ler os carrosséis: ${cars.error.message}`);
  const sdrOptions = ((sdrs.data ?? []) as { sdr_id: string | null; name: string; papel: string; active: boolean; is_bot: boolean }[])
    .filter((u) => u.sdr_id && u.papel === "sdr" && u.active && !u.is_bot)
    .map((u) => ({ id: u.sdr_id!, name: u.name }));
  return (
    <main className="page">
      <div className="page-head"><h1 className="title">Agendar reunião</h1></div>
      <AgendarForm carousels={(cars.data ?? []) as CarouselOption[]} initialLead={sp.lead ?? null} sdrs={isManager(me) ? sdrOptions : null} />
    </main>
  );
}
