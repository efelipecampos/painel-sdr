import Link from "next/link";
import { signIn } from "./actions";

export const metadata = { title: "Entrar — Painel SDR" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ erro?: string }> }) {
  const { erro } = await searchParams;
  return (
    <main className="login">
      <form action={signIn} className="card">
        <h1 className="title">Painel SDR</h1>
        <p className="muted" style={{ margin: 0 }}>Entre com o seu e-mail e a sua senha.</p>
        {erro && <div className="alert" role="alert">{erro}</div>}
        <label className="lbl" htmlFor="email">E-mail</label>
        <input id="email" name="email" type="email" autoComplete="username" required className="field" />
        <label className="lbl" htmlFor="password">Senha</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required className="field" />
        <button type="submit" className="btn primary">Entrar</button>
        <Link href="/login/esqueci" className="muted" style={{ textAlign: "center" }}>Esqueci minha senha</Link>
      </form>
    </main>
  );
}
