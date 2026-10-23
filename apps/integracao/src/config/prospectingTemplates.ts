/**
 * Templates que marcam o início de um ciclo de prospecção (decisão do
 * usuário: só as duas aberturas principais). A partir do disparo de um
 * deles, a primeira mensagem do lead fecha o ciclo e vira o tempo de
 * resposta — ver planCycleUpdate.
 *
 * O mesmo template aparece na Poli em grafias diferentes (recriado com/sem
 * acento, com "#" na frente, com espaço sobrando, variação "fora do
 * expediente"), então a comparação usa uma forma normalizada.
 */
const OPENER_TEMPLATES = [
  "#abertura_concorrente_gatilho1",
  "aberturadomilhão",
  "aberturademilhao",
  " aberturademilhao_foradoexpediente",
];

function normalize(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/^#+/, "");
}

const NORMALIZED_OPENERS = new Set(OPENER_TEMPLATES.map(normalize));

export function isProspectingOpener(templateName: string | undefined): boolean {
  if (!templateName) return false;
  return NORMALIZED_OPENERS.has(normalize(templateName));
}
