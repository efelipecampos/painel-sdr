// Cliente Supabase no servidor (páginas e server actions), com a sessão do usuário nos cookies.
// Usa a chave anon: o acesso é decidido pelo RLS e pelas funções do banco. A service_role nunca entra aqui.
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { cache } from "react";

// cache(): um cliente e um getMe por requisição (o layout e a página reaproveitam, sem ir ao banco de novo).
export const createClient = cache(async function createClient() {
  const store = await cookies();
  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          for (const { name, value, options } of list) store.set(name, value, options);
        } catch {
          // Em Server Components não dá para gravar cookie; o proxy renova a sessão.
        }
      },
    },
  });
});

export type Role = "admin" | "gestor" | "sdr";

export interface Me {
  id: string;
  name: string;
  role: Role;
  sdrId: string | null; // só para o papel sdr: o SDR do usuário
}

export const isManager = (me: Me | null): boolean => me?.role === "admin" || me?.role === "gestor";

/** Usuário logado e ativo, ou null. Uma consulta por requisição (cache). */
export const getMe = cache(async function getMe(): Promise<Me | null> {
  const supabase = await createClient();
  // O proxy já validou a sessão com o servidor de login nesta requisição. Aqui basta o id do cookie:
  // a consulta abaixo leva o token, o banco confere a assinatura e o RLS só devolve o próprio perfil
  // (um token adulterado é recusado pelo banco). Economiza uma ida ao servidor de login (~200 ms).
  const { data: session } = await supabase.auth.getSession();
  const userId = session.session?.user.id;
  if (!userId) return null;
  const { data } = await supabase.schema("painel").from("profiles").select("id, name, role, active, sdr_id").eq("id", userId).maybeSingle();
  if (!data || !data.active) return null;
  if (data.role === "sdr" && !data.sdr_id) return null;
  return { id: data.id, name: data.name, role: data.role, sdrId: data.sdr_id ?? null };
});
