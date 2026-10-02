/**
 * Leads escrevem o nome com letras "estilizadas" (ex.: 𝐏𝐫𝐨𝐝𝐮𝐭𝐨𝐬, fora do
 * alfabeto comum). O HubSpot descarta esses caracteres ao indexar e recusa a
 * busca com "value must be non-empty", então o termo é normalizado antes.
 */
function normalizeForSearch(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

/**
 * A Poli costuma nomear o contato como "Nome - Empresa", "Nome | Empresa -
 * ID" ou "Nome + Empresa" — heurística pra extrair a empresa desse texto,
 * usada como último recurso de busca (Tier 3) antes de desistir e alertar.
 * Best-effort: se não conseguir separar com confiança, retorna null.
 */
export function extractCompanyFromLeadName(leadName: string | undefined): string | null {
  if (!leadName) return null;

  // remove sufixo de id no final, ex: "- 34395", "- #52378", "-52694"
  const withoutId = leadName.replace(/[-|]\s*#?\d+\s*$/, "").trim();

  const separators = [" | ", " + ", " - ", "+", "-"];
  for (const sep of separators) {
    const idx = withoutId.indexOf(sep);
    if (idx > -1) {
      const after = normalizeForSearch(withoutId.slice(idx + sep.length));
      if (after.length >= 3) return after;
    }
  }

  // sem separador reconhecido — se sobrou algo razoável depois de tirar o
  // id, usa o texto inteiro como candidato (ex: nome do lead já é o nome da
  // empresa, sem prefixo de pessoa)
  const inteiro = normalizeForSearch(withoutId);
  return inteiro.length >= 3 ? inteiro : null;
}
