// Aparece na hora do clique, enquanto os dados chegam do banco.
export default function Loading() {
  return (
    <main className="page" aria-busy="true">
      <div className="page-head"><span className="muted">Carregando…</span></div>
      <section className="card" style={{ height: 120, opacity: 0.5 }} />
      <div className="grid-cards">
        {[0, 1, 2].map((i) => <div key={i} className="card" style={{ height: 220, opacity: 0.4 }} />)}
      </div>
    </main>
  );
}
