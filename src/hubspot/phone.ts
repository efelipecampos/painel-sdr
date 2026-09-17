function digitsOnly(input: string): string {
  return input.replace(/\D+/g, "");
}

/**
 * Gera variações plausíveis de um telefone brasileiro (com/sem DDI 55,
 * com/sem o 9º dígito do celular) para buscar contatos no HubSpot, já que
 * não temos garantia de como o número está salvo lá.
 */
export function brazilianPhoneCandidates(rawPhone: string): string[] {
  const digits = digitsOnly(rawPhone);
  if (!digits) return [];

  const variants = new Set<string>([digits]);

  const withCountry = digits.startsWith("55") ? digits : `55${digits}`;
  const withoutCountry = digits.startsWith("55") && digits.length > 11 ? digits.slice(2) : digits;
  variants.add(withCountry);
  variants.add(withoutCountry);

  for (const base of [withCountry, withoutCountry]) {
    const hasCountry = base.startsWith("55") && base.length >= 12;
    const local = hasCountry ? base.slice(2) : base;

    if (local.length === 11 && local[2] === "9") {
      const without9 = local.slice(0, 2) + local.slice(3);
      variants.add(hasCountry ? `55${without9}` : without9);
    }
    if (local.length === 10) {
      const with9 = `${local.slice(0, 2)}9${local.slice(2)}`;
      variants.add(hasCountry ? `55${with9}` : with9);
    }
  }

  const all = new Set<string>();
  for (const v of variants) {
    if (!v) continue;
    all.add(v);
    all.add(`+${v}`);
  }
  return [...all];
}

/**
 * Forma "core" de um telefone BR: DDD + número local de 8 dígitos, sem DDI e
 * sem o 9º dígito. Duas strings de telefone que reduzem pro mesmo core são o
 * mesmo número, independente de pontuação, DDI ou 9º dígito — usado pra
 * confirmar candidatos vindos de uma busca ampla (ver findContactIdByPhone).
 */
export function corePhoneDigits(rawPhone: string): string {
  let digits = digitsOnly(rawPhone);
  if (digits.startsWith("55") && digits.length >= 12) {
    digits = digits.slice(2);
  }
  if (digits.length === 11 && digits[2] === "9") {
    digits = digits.slice(0, 2) + digits.slice(3);
  }
  return digits;
}

/** Últimos N dígitos do telefone — usado como termo de busca CONTAINS_TOKEN. */
export function phoneSuffix(rawPhone: string, length = 4): string {
  return digitsOnly(rawPhone).slice(-length);
}
