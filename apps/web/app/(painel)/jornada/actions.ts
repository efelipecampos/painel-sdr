"use server";

// Jornada · Regras (Fase 11, docs/jornada.md). Grava com a sessão do usuário: o RLS só deixa gestor e admin.
// O envio de teste chama a API do Poli no servidor (token só aqui, nunca no navegador). Nada de texto de mensagem
// nem telefone em log.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient, getMe, isManager } from "@/lib/supabase/server";
import { preencher, variaveisDesconhecidas, type Janela } from "@painel/shared/jornada";
import { PoliApi, PoliError } from "@painel/shared/poli";

export interface Resultado { ok: boolean; msg: string }

const JANELAS: Janela[] = ["expediente", "fora", "sempre"];

async function guard() {
  const me = await getMe();
  if (!isManager(me)) redirect("/");
  return { me: me!, db: (await createClient()).schema("painel") };
}

const fim = <T extends Resultado>(r: T): T => {
  revalidatePath("/jornada");
  return r;
};

/** Só dígitos, com DDI 55: o formato que a API do Poli usa para o telefone. */
function normalizarTelefone(t: string): string | null {
  const d = t.replace(/\D/g, "");
  if (!d) return null;
  const com55 = d.length <= 11 ? `55${d}` : d;
  return /^55\d{10,11}$/.test(com55) ? com55 : "";
}

export async function salvarTelefone(telefone: string): Promise<Resultado> {
  const { db } = await guard();
  const t = normalizarTelefone(telefone);
  if (t === "") return { ok: false, msg: "Telefone inválido. Use DDD + número, por exemplo (62) 9 8888-0000." };
  const { error } = await db.from("journey_config").update({ test_phone: t }).eq("id", true);
  if (error) return { ok: false, msg: "Não foi possível salvar o telefone." };
  return fim({ ok: true, msg: t ? "Telefone de teste salvo." : "Telefone de teste removido." });
}

export async function pausarJornada(pausar: boolean): Promise<Resultado> {
  const { db } = await guard();
  const { error } = await db.from("journey_config").update({ paused: pausar }).eq("id", true);
  if (error) return { ok: false, msg: "Não foi possível mudar a jornada." };
  return fim({ ok: true, msg: pausar ? "Jornada pausada." : "Jornada retomada." });
}

export interface RegraForm {
  id: string | null;
  origin: string;
  button: string;
  janela: Janela;
  dest: string;
  limit: number | null;
}

const CAMPOS = "origin_template_uuid, origin_button, janela, dest_template_uuid, status, daily_limit, paused_reason";

export async function salvarRegra(f: RegraForm): Promise<Resultado & { id?: string }> {
  const { me, db } = await guard();
  if (!f.origin || !f.button || !f.dest || !JANELAS.includes(f.janela)) return { ok: false, msg: "Preencha o template de origem, o botão, o horário e o template a enviar." };
  if (f.origin === f.dest) return { ok: false, msg: "O template a enviar precisa ser diferente do de origem." };
  const limite = f.limit === null ? null : Math.round(Number(f.limit));
  if (limite !== null && (!Number.isFinite(limite) || limite < 1)) return { ok: false, msg: "O limite por dia precisa ser 1 ou mais." };
  const { data: origem } = await db.from("poli_templates").select("buttons").eq("uuid", f.origin).maybeSingle();
  const botoes = ((origem?.buttons as { text: string }[] | null) ?? []).map((b) => b.text);
  if (!botoes.includes(f.button)) return { ok: false, msg: "Esse botão não existe no template de origem." };
  const novo = { origin_template_uuid: f.origin, origin_button: f.button, janela: f.janela, dest_template_uuid: f.dest, daily_limit: limite };

  if (!f.id) {
    const { data, error } = await db.from("journey_rules").insert({ ...novo, status: "teste", created_by: me.id }).select("id").single();
    if (error) return { ok: false, msg: error.code === "23505" ? "Já existe uma regra para esse template, botão e horário." : "Não foi possível criar a regra." };
    await db.from("journey_rule_changes").insert({ rule_id: data.id, action: "criou", changed_by: me.id, after: novo });
    return fim({ ok: true, msg: "Regra criada em teste.", id: data.id });
  }
  const { data: antes } = await db.from("journey_rules").select(CAMPOS).eq("id", f.id).single();
  const { error } = await db.from("journey_rules").update(novo).eq("id", f.id);
  if (error) return { ok: false, msg: error.code === "23505" ? "Já existe uma regra para esse template, botão e horário." : "Não foi possível salvar a regra." };
  await db.from("journey_rule_changes").insert({ rule_id: f.id, action: "mudou", changed_by: me.id, before: antes, after: novo });
  return fim({ ok: true, msg: "Alterações salvas.", id: f.id });
}

/** Pausar (em teste ou ativa) ou retomar (volta para ativa se já tinha sido ativada; senão, para teste). */
export async function alternarRegra(id: string): Promise<Resultado> {
  const { me, db } = await guard();
  const { data: r } = await db.from("journey_rules").select(CAMPOS).eq("id", id).single();
  if (!r) return { ok: false, msg: "Regra não encontrada." };
  if (r.status !== "pausada") {
    await db.from("journey_rules").update({ status: "pausada", paused_reason: "manual" }).eq("id", id);
    await db.from("journey_rule_changes").insert({ rule_id: id, action: "pausou", changed_by: me.id, before: { status: r.status }, after: { status: "pausada" } });
    return fim({ ok: true, msg: "Regra pausada." });
  }
  const { count } = await db.from("journey_rule_changes").select("id", { count: "exact", head: true }).eq("rule_id", id).eq("action", "ativou");
  const volta = count ? "ativa" : "teste";
  await db.from("journey_rules").update({ status: volta, paused_reason: null }).eq("id", id);
  await db.from("journey_rule_changes").insert({ rule_id: id, action: "retomou", changed_by: me.id, before: { status: "pausada" }, after: { status: volta } });
  return fim({ ok: true, msg: volta === "ativa" ? "Regra retomada: envia para os leads." : "Regra retomada em teste." });
}

export async function ativarRegra(id: string): Promise<Resultado> {
  const { me, db } = await guard();
  const { data: r } = await db.from("journey_rules").select("status, dest_template_uuid").eq("id", id).single();
  if (!r || r.status !== "teste") return { ok: false, msg: "Só uma regra em teste pode ser ativada." };
  const { data: dest } = await db.from("poli_templates").select("body").eq("uuid", r.dest_template_uuid).maybeSingle();
  if (!dest) return { ok: false, msg: "O template a enviar não está mais na lista do Poli." };
  const ruins = variaveisDesconhecidas(dest.body ?? "");
  if (ruins.length) return { ok: false, msg: `O template tem variável que o painel não sabe preencher: ${ruins.map((v) => `[${v}]`).join(", ")}.` };
  await db.from("journey_rules").update({ status: "ativa", paused_reason: null }).eq("id", id);
  await db.from("journey_rule_changes").insert({ rule_id: id, action: "ativou", changed_by: me.id, before: { status: "teste" }, after: { status: "ativa" } });
  return fim({ ok: true, msg: "Regra ativa. Desligue no n8n a regra equivalente hoje." });
}

/** Manda o template de destino para o telefone de teste, com um lead de exemplo e o nome de quem testou. */
export async function enviarTeste(destUuid: string): Promise<Resultado> {
  const { me, db } = await guard();
  const base = process.env.POLI_API_BASE_URL?.trim(), token = process.env.POLI_API_TOKEN?.trim();
  if (!base || !token) return { ok: false, msg: "A API do Poli não está configurada no servidor." };
  const { data: conf } = await db.from("journey_config").select("test_phone").single();
  if (!conf?.test_phone) return { ok: false, msg: "Cadastre o telefone de teste acima." };
  const { data: dest } = await db.from("poli_templates").select("uuid, body").eq("uuid", destUuid).maybeSingle();
  if (!dest) return { ok: false, msg: "Template não encontrado." };
  const dados = preencher(dest.body ?? "", { leadNome: "Renata Exemplo", sdrNome: me.name });
  if (!dados.ok) return { ok: false, msg: `Corrija a variável [${dados.falta}] antes de enviar.` };
  try {
    await new PoliApi(base, token).sendToPhone(
      process.env.POLI_ACCOUNT_UUID?.trim() || "9b8af98e-0407-49a2-bce9-3620f29c513a",
      String(conf.test_phone),
      { templateUuid: dest.uuid, channelUuid: process.env.POLI_CHANNEL_UUID?.trim() || "9b8bae9e-2fe2-4f2a-82a2-abb931c7d7ce", bodyParams: dados.params },
    );
    const hora = new Date().toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });
    return { ok: true, msg: `Enviado para o telefone de teste às ${hora}.` };
  } catch (e) {
    return { ok: false, msg: e instanceof PoliError ? `O Poli recusou o envio (HTTP ${e.status}: ${e.reason}).` : "Não foi possível enviar." };
  }
}

/** Texto e botões de um template (para a prévia, quando ele não veio na carga da página). */
export async function textoTemplate(uuid: string): Promise<{ body: string; buttons: string[] } | null> {
  const { db } = await guard();
  const { data } = await db.from("poli_templates").select("body, buttons").eq("uuid", uuid).maybeSingle();
  return data ? { body: data.body ?? "", buttons: ((data.buttons as { text: string }[]) ?? []).map((b) => b.text) } : null;
}
