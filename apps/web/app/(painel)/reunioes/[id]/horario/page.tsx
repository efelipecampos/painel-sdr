import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { formatDateTime, formatTime } from "@/lib/time";
import { HorarioForm } from "./HorarioForm";

export const metadata = { title: "Mudar horário — Painel SDR" };

// Editar (mesmo dia) e Reagendar (outro dia) usam o mesmo fluxo: o mesmo evento e o mesmo link do Meet.
export default async function HorarioPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = (await createClient()).schema("painel");
  const [{ data: perm }, { data }] = await Promise.all([db.rpc("permissao_reuniao", { p_id: id }), db.rpc("reuniao_detalhe", { p_id: id })]);
  const m = (data ?? [])[0] as { title: string; starts_at: string; ends_at: string; status: string } | undefined;
  if (!m || (perm !== "sdr" && perm !== "gestor")) notFound();
  const duration = Math.round((Date.parse(m.ends_at) - Date.parse(m.starts_at)) / 60_000);
  return (
    <main className="page">
      <div className="page-head"><h1 className="title">{m.status === "cancelada" ? "Reagendar" : "Mudar horário"}</h1></div>
      <p style={{ margin: 0 }}><strong>{m.title}</strong> · hoje marcada para {formatDateTime(m.starts_at)}–{formatTime(new Date(m.ends_at))}</p>
      <p className="muted" style={{ margin: 0 }}>
        O convite é o mesmo (mesmo link do Meet). O sistema tenta manter o mesmo closer; se ele não estiver livre no novo horário, o carrossel escolhe outro.
      </p>
      <HorarioForm id={id} initialDuration={duration} />
    </main>
  );
}
