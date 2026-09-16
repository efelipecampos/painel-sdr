import { env } from "./env.js";

const sdrCloserEmails = new Set(
  env.POLI_SDR_CLOSER_EMAILS.split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean),
);

/**
 * Whitelist de e-mails do time de pré-vendas (SDR/Closer). A Poli não expõe
 * departamento/fila no webhook — só o e-mail do atendente — então o filtro é
 * mantido aqui e editado conforme o time muda.
 */
export function isPreSalesAttendant(email: string | undefined | null): boolean {
  if (!email) return false;
  return sdrCloserEmails.has(email.trim().toLowerCase());
}

export function getPreSalesEmailCount(): number {
  return sdrCloserEmails.size;
}
