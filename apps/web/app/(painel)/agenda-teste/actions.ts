"use server";

// Tela de teste da agenda (só admin): cria, altera, arquiva, traz de volta e apaga um evento de teste na
// agenda de um closer conectado. O único convidado é o próprio admin. Tudo fica no registro de chamadas.
import { redirect } from "next/navigation";
import { ARCHIVE_COLOR } from "@painel/shared/google";
import { APP_URL, calendarOf, withLog } from "@/lib/google";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient, getMe } from "@/lib/supabase/server";
import { localToDate } from "@/lib/time";

async function guard() {
  const me = await getMe();
  if (me?.role !== "admin") redirect("/");
  return me;
}

const go = (q: Record<string, string>, erro?: string): never =>
  redirect(`/agenda-teste?${new URLSearchParams({ ...q, ...(erro ? { erro } : {}) })}`);

async function archiveId(): Promise<string> {
  const { data } = await (await createClient()).schema("painel").from("settings").select("value").eq("key", "google_archive_calendar_id").maybeSingle();
  return String(data?.value ?? "").trim();
}

async function closerEmail(closerId: string): Promise<string> {
  const { data } = await createAdminClient().schema("painel").from("google_connections").select("google_email").eq("closer_id", closerId).single();
  return data!.google_email;
}

export async function criarTeste(form: FormData) {
  await guard();
  const closer = String(form.get("closer"));
  const dia = String(form.get("dia"));
  const hora = String(form.get("hora"));
  const q = { closer, dia };
  const { data: u } = await (await createClient()).auth.getUser();
  let r: { id: string } | undefined;
  try {
    const cal = await calendarOf(closer);
    const { data: s } = await createAdminClient().schema("painel").from("sdrs").select("name").eq("id", closer).single();
    const start = localToDate(`${dia}T${hora}`);
    r = await withLog(closer, "criar", () => cal.insert({
      title: `TESTE | Painel SDR | ${s?.name ?? "Closer"}`,
      description: `Evento de teste do Painel SDR. Pode ser apagado.\n\nPassagem de bastão (equipe): ${APP_URL}/agenda-teste`,
      start, end: new Date(start.getTime() + 30 * 60_000),
      attendees: u.user?.email ? [u.user.email] : [],
    }));
  } catch (e) {
    go(q, (e as Error).message);
  }
  go({ ...q, ev: r!.id, onde: "closer" });
}

export async function operarTeste(form: FormData) {
  await guard();
  const closer = String(form.get("closer"));
  const dia = String(form.get("dia"));
  const ev = String(form.get("ev"));
  const onde = String(form.get("onde"));
  const op = String(form.get("op"));
  const q = { closer, dia, ev, onde };
  let next = onde;
  try {
    const cal = await calendarOf(closer);
    const arq = await archiveId();
    const here = onde === "arquivo" ? arq : "primary";
    if (op === "mais1h") {
      const cur = await cal.get(ev, here);
      if (!cur?.start?.dateTime || !cur.end?.dateTime) throw new Error("Evento não encontrado no Google.");
      await withLog(closer, "alterar", () => cal.patch(ev, {
        start: new Date(Date.parse(cur.start!.dateTime!) + 3600_000), end: new Date(Date.parse(cur.end!.dateTime!) + 3600_000),
      }, here));
    } else if (op === "arquivar") {
      if (!arq) throw new Error("Cadastre o ID da agenda de arquivo em Configurações.");
      await withLog(closer, "mover", () => cal.move(ev, arq, "primary"));
      await withLog(closer, "alterar", () => cal.patch(ev, { colorId: ARCHIVE_COLOR.cancelada }, arq, false));
      next = "arquivo";
    } else if (op === "voltar") {
      const dest = await closerEmail(closer); // id da agenda principal do closer = e-mail dele
      await withLog(closer, "mover", () => cal.move(ev, dest, arq));
      await withLog(closer, "alterar", () => cal.patch(ev, { colorId: null }, dest, false));
      next = "closer";
    } else if (op === "apagar") {
      await withLog(closer, "apagar", () => cal.remove(ev, here));
      go({ closer, dia }, undefined);
    }
  } catch (e) {
    go(q, (e as Error).message);
  }
  go({ ...q, onde: next });
}

