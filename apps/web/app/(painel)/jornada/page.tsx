// Jornada · Regras (Fase 11). Desenho: design/JornadaRegras.dc.html. Só gestor e admin.
import { redirect } from "next/navigation";
import { createClient, getMe, isManager } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { localToDate, localDay } from "@/lib/time";
import { JornadaTabs } from "./JornadaTabs";
import { carregarTemplates } from "./templates";
import { RegrasView, type RegraLinha } from "./RegrasView";
import s from "./jornada.module.css";

export const dynamic = "force-dynamic";

const DIAS = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const quando = (iso: string) => new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).replace(",", "");

/** "seg a sex, 08:20 às 17:45, sem feriados" a partir do horário comercial das Configurações. */
function textoExpediente(rows: { weekday: number; enabled: boolean; start_time: string; end_time: string }[]): string {
  const on = rows.filter((r) => r.enabled).sort((a, b) => a.weekday - b.weekday);
  if (!on.length) return "sem horário comercial configurado";
  const mesmo = on.every((r) => r.start_time === on[0].start_time && r.end_time === on[0].end_time);
  const seguidos = on.every((r, i) => i === 0 || r.weekday === on[i - 1].weekday + 1);
  const dias = seguidos && on.length > 1 ? `${DIAS[on[0].weekday]} a ${DIAS[on[on.length - 1].weekday]}` : on.map((r) => DIAS[r.weekday]).join(", ");
  return mesmo ? `${dias}, ${on[0].start_time.slice(0, 5)} às ${on[0].end_time.slice(0, 5)}, sem feriados` : `${dias}, sem feriados`;
}

const ACAO: Record<string, string> = {
  criou: "criou, em teste", mudou: "mudou a regra", ativou: "ativou", pausou: "pausou", retomou: "retomou", voltou_teste: "voltou para teste",
};

export default async function JornadaRegrasPage() {
  const me = await getMe();
  if (!isManager(me)) redirect("/");
  const db = (await createClient()).schema("painel");
  const admin = createAdminClient().schema("painel");

  const [{ data: conf }, { data: regras }, { data: horas }] = await Promise.all([
    db.from("journey_config").select("paused, test_phone, updated_at, updated_by").single(),
    db.from("journey_rules").select("id, origin_template_uuid, origin_button, janela, tipo, dest_template_uuid, texto, status, daily_limit, paused_reason, created_at").order("created_at"),
    db.from("business_hours").select("weekday, enabled, start_time, end_time"),
  ]);
  const ids = (regras ?? []).map((r) => r.id);

  // Envios de hoje (dia de São Paulo), por regra.
  const hoje = localToDate(`${localDay(new Date())}T00:00`).toISOString();
  const { data: envios } = ids.length
    ? await db.from("journey_sends").select("rule_id, mode, status").in("rule_id", ids).gte("created_at", hoje).limit(10000)
    : { data: [] };
  const { data: mudancas } = ids.length
    ? await db.from("journey_rule_changes").select("rule_id, action, changed_at, changed_by").in("rule_id", ids).order("changed_at", { ascending: false }).limit(500)
    : { data: [] };

  // Nomes de quem mexeu (perfis de outros usuários só com a service_role).
  const pessoas = new Set<string>([...(mudancas ?? []).map((m) => m.changed_by), conf?.updated_by].filter(Boolean) as string[]);
  const { data: perfis } = pessoas.size ? await admin.from("profiles").select("id, name").in("id", [...pessoas]) : { data: [] };
  const nome = (id: string | null) => (id === me!.id ? "você" : ((perfis ?? []).find((p) => p.id === id)?.name ?? "").split(" ")[0] || "alguém");

  // Templates para a busca: os usados no mês primeiro (texto completo também dos que estão em regras).
  const templates = await carregarTemplates(db, new Set((regras ?? []).flatMap((r) => [r.origin_template_uuid, r.dest_template_uuid]).filter(Boolean) as string[]));

  const linhas: RegraLinha[] = (regras ?? []).map((r) => {
    const meus = (envios ?? []).filter((e) => e.rule_id === r.id);
    const hist = (mudancas ?? []).filter((m) => m.rule_id === r.id);
    const limite = r.status === "pausada" && r.paused_reason === "limite_diario";
    return {
      id: r.id, origin: r.origin_template_uuid, button: r.origin_button, janela: r.janela, tipo: r.tipo, dest: r.dest_template_uuid ?? "", texto: r.texto ?? "",
      status: limite ? "limite" : r.status, limit: r.daily_limit,
      enviados: meus.filter((e) => e.status === "enviado").length,
      falhas: meus.filter((e) => e.status === "falhou").length,
      limiteEm: limite ? quando(hist.find((m) => m.action === "pausou_limite")?.changed_at ?? r.created_at).slice(6) : null,
      historico: hist.map((m) => ({
        quando: quando(m.changed_at),
        oque: m.action === "pausou_limite" ? "Pausou sozinha: bateu o limite do dia" : `${nome(m.changed_by).replace(/^./, (c: string) => c.toUpperCase())} ${ACAO[m.action] ?? m.action}`,
      })),
    };
  });

  return (
    <main className={s.page}>
      <JornadaTabs atual="regras" />
      <RegrasView
        regras={linhas}
        templates={templates}
        pausada={!!conf?.paused}
        pausaInfo={conf?.paused ? `Pausada por ${nome(conf.updated_by ?? null)} às ${quando(conf.updated_at).slice(6)}.` : ""}
        telefone={(conf?.test_phone as string | null) ?? ""}
        telefoneInfo={conf?.test_phone ? `${quando(conf.updated_at)} por ${nome(conf.updated_by ?? null)}` : ""}
        expediente={textoExpediente(horas ?? [])}
        sdrExemplo={me!.name}
      />
    </main>
  );
}
