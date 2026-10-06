import type { ReactNode } from "react";
import Link from "next/link";
import { getMe } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function PainelLayout({ children }: { children: ReactNode }) {
  const me = await getMe();
  if (!me) {
    return (
      <main className="login">
        <div className="card" style={{ maxWidth: 420 }}>
          <h1 className="title">Sem acesso</h1>
          <p style={{ margin: 0 }}>Seu usuário ainda não tem acesso ao painel ou foi desativado. Fale com o administrador.</p>
          <form action="/sair" method="post"><button className="btn" type="submit">Sair</button></form>
        </div>
      </main>
    );
  }
  return (
    <>
      <header className="topbar">
        <Link href="/" className="brand">Painel SDR</Link>
        <span className="spacer" />
        {me.role === "admin" && <Link href="/configuracoes" className="btn small">Configurações</Link>}
        <span className="user">{me.name}</span>
        <form action="/sair" method="post"><button className="btn small" type="submit">Sair</button></form>
      </header>
      {children}
    </>
  );
}
