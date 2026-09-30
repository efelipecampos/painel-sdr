// Código comum ao web e ao worker.

/** Fuso de negócio. Tudo é guardado em UTC e convertido só na borda. */
export const BUSINESS_TIMEZONE = "America/Sao_Paulo";

/** Classificação do remetente de uma mensagem (enum painel.sender_type). */
export type SenderType = "lead" | "sdr" | "bot" | "template" | "system";

/** Status de reunião (enum painel.meeting_status). */
export type MeetingStatus = "agendada" | "validada" | "noshow" | "invalidada" | "cancelada";
