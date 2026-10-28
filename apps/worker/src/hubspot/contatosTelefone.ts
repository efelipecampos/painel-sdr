// Contatos do HubSpot com o mesmo telefone (2026-10-28: o lead se cadastrou de novo, o HubSpot criou outro contato com
// o mesmo número e o Lead novo ficou nele; o painel conhecia só o contato antigo e o descarte por tag não pegou o Lead
// novo). Mesmas variações de telefone da integração (apps/integracao/src/hubspot/phone.ts). LGPD: o telefone não vai
// para log.
import type { HubspotClient } from "./leads.js";

const soDigitos = (s: string) => s.replace(/\D+/g, "");

/** Variações de um telefone brasileiro: com/sem DDI 55, com/sem o 9º dígito, com/sem "+". */
export function variacoesTelefone(bruto: string): string[] {
  const d = soDigitos(bruto);
  if (!d) return [];
  const v = new Set<string>([d]);
  const com55 = d.startsWith("55") ? d : `55${d}`;
  const sem55 = d.startsWith("55") && d.length > 11 ? d.slice(2) : d;
  v.add(com55);
  v.add(sem55);
  for (const base of [com55, sem55]) {
    const tem55 = base.startsWith("55") && base.length >= 12;
    const local = tem55 ? base.slice(2) : base;
    if (local.length === 11 && local[2] === "9") v.add((tem55 ? "55" : "") + local.slice(0, 2) + local.slice(3));
    if (local.length === 10) v.add((tem55 ? "55" : "") + `${local.slice(0, 2)}9${local.slice(2)}`);
  }
  return [...v].flatMap((x) => [x, `+${x}`]);
}

/** DDD + 8 dígitos, sem DDI nem 9º dígito: dois telefones com o mesmo núcleo são o mesmo número. */
export function nucleoTelefone(bruto: string): string {
  let d = soDigitos(bruto);
  if (d.startsWith("55") && d.length >= 12) d = d.slice(2);
  if (d.length === 11 && d[2] === "9") d = d.slice(0, 2) + d.slice(3);
  return d;
}

/** Todos os contatos do HubSpot cujo telefone (phone ou mobilephone) é o mesmo número. */
export async function contatosPorTelefone(hs: Pick<HubspotClient, "call">, bruto: string | null | undefined): Promise<string[]> {
  const nucleo = bruto ? nucleoTelefone(bruto) : "";
  if (nucleo.length < 10) return [];
  const busca = (filterGroups: unknown[]) => hs.call<{ results?: { id: string; properties: Record<string, string | null> }[] }>(
    "/crm/v3/objects/contacts/search", { filterGroups, properties: ["phone", "mobilephone"], limit: 50 });
  const exatos = await busca(["phone", "mobilephone"].map((p) => ({ filters: [{ propertyName: p, operator: "IN", values: variacoesTelefone(bruto!) }] })));
  // telefone salvo com pontuação: busca pelos 4 últimos dígitos e confere o núcleo
  const fim = soDigitos(bruto!).slice(-4);
  const amplos = await busca(["phone", "mobilephone"].map((p) => ({ filters: [{ propertyName: p, operator: "CONTAINS_TOKEN", value: fim }] })));
  const ids = new Set<string>();
  for (const c of [...(exatos.results ?? []), ...(amplos.results ?? [])]) {
    if ([c.properties.phone, c.properties.mobilephone].some((t) => t && nucleoTelefone(t) === nucleo)) ids.add(c.id);
  }
  return [...ids];
}
