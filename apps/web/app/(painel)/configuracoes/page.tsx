import { redirect } from "next/navigation";
import { getSettings } from "@/lib/data";
import { createClient, getMe } from "@/lib/supabase/server";
import { QualityForm } from "./QualityForm";
import { SettingsForm } from "./SettingsForm";

export const metadata = { title: "Configurações — Painel SDR" };

export default async function ConfiguracoesPage({ searchParams }: { searchParams: Promise<{ salvo?: string; erro?: string }> }) {
  const me = await getMe();
  if (me?.role !== "admin") redirect("/");
  const sp = await searchParams;
  const supabase = await createClient();
  const [hours, holidays, settings, criteria, context] = await Promise.all([
    supabase.schema("painel").from("business_hours").select("weekday, enabled, start_time, end_time").order("weekday"),
    supabase.schema("painel").from("holidays").select("day, name").order("day"),
    getSettings(),
    supabase.schema("painel").from("quality_criteria").select("id, name, description, weight").eq("active", true).order("sort"),
    supabase.schema("painel").from("settings").select("value").eq("key", "quality_context").maybeSingle(),
  ]);
  if (hours.error) throw new Error(hours.error.message);
  if (holidays.error) throw new Error(holidays.error.message);
  if (criteria.error) throw new Error(criteria.error.message);
  if (context.error) throw new Error(context.error.message);

  return (
    <main className="page">
      <div className="page-head">
        <h1 className="title">Configurações do Painel SDR</h1>
      </div>
      {sp.salvo && <div className="ok" role="status">Configurações salvas.</div>}
      {sp.erro && <div className="alert" role="alert">{sp.erro}</div>}
      <SettingsForm
        hours={(hours.data ?? []).map((h) => ({ ...h, start_time: h.start_time.slice(0, 5), end_time: h.end_time.slice(0, 5) }))}
        holidays={holidays.data ?? []}
        settings={settings}
      />
      <QualityForm context={typeof context.data?.value === "string" ? context.data.value : ""} criteria={criteria.data ?? []} />
    </main>
  );
}
