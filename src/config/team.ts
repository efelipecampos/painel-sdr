import { env } from "./env.js";

export type AttendantRole = "SDR" | "CLOSER";

function parseEmailList(raw: string): Set<string> {
  return new Set(
    raw
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

const sdrEmails = parseEmailList(env.POLI_SDR_EMAILS);
const closerEmails = parseEmailList(env.POLI_CLOSER_EMAILS);

/**
 * Papel do atendente da Poli (SDR ou Closer), a partir de uma whitelist
 * mantida na config — a Poli não expõe departamento/fila no webhook, só o
 * e-mail do atendente. E-mails fora das duas listas (ex.: gestores) voltam
 * null e a mensagem é ignorada, igual antes.
 */
export function getAttendantRole(email: string | undefined | null): AttendantRole | null {
  if (!email) return null;
  const normalized = email.trim().toLowerCase();
  if (sdrEmails.has(normalized)) return "SDR";
  if (closerEmails.has(normalized)) return "CLOSER";
  return null;
}

export function getPreSalesEmailCount(): number {
  return sdrEmails.size + closerEmails.size;
}
