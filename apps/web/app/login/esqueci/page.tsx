import Link from "next/link";
import { esqueciSenha } from "./actions";

export const metadata = { title: "Esqueci minha senha — Painel SDR" };

export default async function EsqueciPage({ searchParams }: { searchParams: Promise<{ erro?: string; enviado?: string }> }) {
  const { erro, enviado } = await searchParams;
  return (
    <main className="login">
      <form action={esqueciSenha} className="card">
        <h1 className="title">Esqueci minha senha</h1>
        {enviado ? (
          <div className="ok" role="status">Se esse e-mail tem acesso ao painel, você vai receber um link para criar uma senha nova em alguns minutos. Confira também o spam.</div>
        ) : (
          <p className="muted" style={{ margin: 0 }}>Informe o seu e-mail. Vamos mandar um link para você criar uma senha nova.</p>
        )}
        {erro && <div className="alert" role="alert">{erro}</div>}
        <label className="lbl" htmlFor="email">E-mail</label>
        <input id="email" name="email" type="email" autoComplete="username" required className="field" />
        <button type="submit" className="btn primary">Enviar link</button>
        <Link href="/login" className="muted" style={{ textAlign: "center" }}>Voltar para o login</Link>
      </form>
    </main>
  );
}
