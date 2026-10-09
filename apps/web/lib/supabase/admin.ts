// Cliente Supabase com a service_role. SÓ no servidor (rotas e server actions), e só para o que o usuário
// logado não pode fazer com a própria sessão: guardar e usar a conexão do Google dos closers, criar login
// (convite por e-mail) e mandar link de senha na tela Usuários.
// A chave não começa com NEXT_PUBLIC_, então o Next nunca a envia ao navegador.
import { createClient } from "@supabase/supabase-js";

export function createAdminClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY não definida no servidor.");
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
