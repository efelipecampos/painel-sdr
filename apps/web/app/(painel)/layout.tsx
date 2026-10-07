import type { ReactNode } from "react";
import Link from "next/link";
import { getMe, isManager } from "@/lib/supabase/server";

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
        <Link href={me.role === "sdr" ? `/sdr/${me.sdrId}` : "/"} className="brand">Painel SDR</Link>
        <nav className="group" aria-label="Navegação">
          {isManager(me) && <Link href="/" className="btn small">Painel</Link>}
          {isManager(me) && <Link href="/carrosseis" className="btn small">Carrosséis</Link>}
          {me.role === "sdr" && <Link href={`/sdr/${me.sdrId}`} className="btn small">Meus chats</Link>}
        </nav>
        <span className="spacer" />
        {me.canManageUsers && <Link href="/usuarios" className="btn small">Usuários</Link>}
        {me.role === "admin" && <Link href="/configuracoes" className="btn small">Configurações</Link>}
        <span className="user">{me.name}</span>
        <form action="/sair" method="post"><button className="btn small" type="submit">Sair</button></form>
      </header>
      {children}
    </>
  );
}
