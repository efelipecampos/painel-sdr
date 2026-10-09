import { definirSenha } from "./actions";

export const metadata = { title: "Criar senha — Painel SDR" };

// Chega aqui pelo link do convite ou do "Esqueci minha senha" (sessão aberta por /auth/confirm).
export default async function DefinirSenhaPage({ searchParams }: { searchParams: Promise<{ erro?: string }> }) {
  const { erro } = await searchParams;
  return (
    <main className="login">
      <form action={definirSenha} className="card">
        <h1 className="title">Criar senha</h1>
        <p className="muted" style={{ margin: 0 }}>Escolha a senha que você vai usar para entrar no painel. Mínimo de 8 caracteres.</p>
        {erro && <div className="alert" role="alert">{erro}</div>}
        <label className="lbl" htmlFor="senha">Senha nova</label>
        <input id="senha" name="senha" type="password" autoComplete="new-password" minLength={8} required className="field" />
        <label className="lbl" htmlFor="confirma">Repita a senha</label>
        <input id="confirma" name="confirma" type="password" autoComplete="new-password" minLength={8} required className="field" />
        <button type="submit" className="btn primary">Salvar e entrar</button>
      </form>
    </main>
  );
}
