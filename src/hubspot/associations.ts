import { hubspotFetch } from "./client.js";

interface AssociationLabel {
  category: "HUBSPOT_DEFINED" | "USER_DEFINED";
  typeId: number;
  label: string | null;
}

interface AssociationLabelsResponse {
  results: AssociationLabel[];
}

const cache = new Map<string, number>();

/**
 * Busca dinamicamente o associationTypeId padrão entre dois tipos de objeto
 * (ex.: communications -> contacts), em vez de fixar um número no código —
 * evita associar errado caso o ID padrão do HubSpot não seja o que
 * assumimos.
 */
export async function getDefaultAssociationTypeId(
  fromObjectType: string,
  toObjectType: string,
): Promise<number> {
  const key = `${fromObjectType}:${toObjectType}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const res = await hubspotFetch<AssociationLabelsResponse>(
    `/crm/v4/associations/${fromObjectType}/${toObjectType}/labels`,
  );

  const defaultLabel =
    res.results.find((r) => r.category === "HUBSPOT_DEFINED" && r.label === null) ?? res.results[0];

  if (!defaultLabel) {
    throw new Error(`Nenhum associationTypeId encontrado para ${fromObjectType} -> ${toObjectType}`);
  }

  cache.set(key, defaultLabel.typeId);
  return defaultLabel.typeId;
}
