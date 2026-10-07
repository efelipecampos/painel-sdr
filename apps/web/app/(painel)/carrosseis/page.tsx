import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient, getMe, isManager } from "@/lib/supabase/server";
import { dateToLocal } from "@/lib/time";
import { CarouselEditor, type CarouselRow, type MemberRow } from "./CarouselEditor";
import { createCarousel } from "./actions";

export const metadata = { title: "Carrosséis — Painel SDR" };

const BRAND: Record<string, string> = { poli: "Poli", chatshub: "ChatsHub" };

function monthOptions(): { key: string; label: string }[] {
  const now = dateToLocal(new Date()); // AAAA-MM-DDTHH:mm no fuso de negócio
  let y = Number(now.slice(0, 4));
  let m = Number(now.slice(5, 7));
  const out = [];
  for (let i = 0; i < 3; i++) {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    const label = new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString("pt-BR", { month: "long", year: "numeric", timeZone: "UTC" });
    out.push({ key, label: label.charAt(0).toUpperCase() + label.slice(1) });
    m -= 1;
    if (m === 0) { m = 12; y -= 1; }
  }
  return out;
}

export default async function CarrosseisPage({ searchParams }: { searchParams: Promise<{ c?: string; periodo?: string; salvo?: string; erro?: string }> }) {
  const me = await getMe();
  if (!isManager(me)) redirect("/");
  const sp = await searchParams;
  const db = (await createClient()).schema("painel");
  const { data: carousels, error } = await db.from("carousels").select("*").order("brand").order("sort").order("name");
  if (error) throw new Error(`Não foi possível ler os carrosséis: ${error.message}`);
  const list = (carousels ?? []) as CarouselRow[];
  const selected = list.find((c) => c.id === sp.c) ?? list.find((c) => c.active) ?? list[0];
  const months = monthOptions();
  const period = selected?.balance_period === "week" ? null : (months.find((m) => m.key === sp.periodo)?.key ?? months[0].key);

  const [resumo, closers] = selected
    ? await Promise.all([
        db.rpc("carrossel_resumo", { p_carousel: selected.id, p_period_key: period }),
        db.rpc("closers_para_carrossel"),
      ])
    : [{ data: [] }, { data: [] }];

  return (
    <main className="page">
      <div className="page-head">
        <h1 className="title">Carrosséis</h1>
        <span className="spacer" />
        {selected && selected.balance_period !== "week" && (
          <form className="group">
            <input type="hidden" name="c" value={selected.id} />
            <label className="lbl" htmlFor="periodo">Período</label>
            <select id="periodo" name="periodo" className="field" defaultValue={period ?? ""}>
              {months.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
            </select>
            <button className="btn small" type="submit">Ver</button>
          </form>
        )}
      </div>
      {sp.salvo && <div className="ok" role="status">Carrossel salvo.</div>}
      {sp.erro && <div className="alert" role="alert">{sp.erro}</div>}

      <div className="carousel-layout">
        <aside className="card" aria-label="Lista de carrosséis">
          {(["poli", "chatshub"] as const).map((b) => (
            <div key={b} className="cell-stack" style={{ gap: 6 }}>
              <span className="muted">{BRAND[b]}</span>
              {list.filter((c) => c.brand === b).map((c) => (
                <Link key={c.id} href={`/carrosseis?c=${c.id}`} className="btn small"
                  aria-pressed={c.id === selected?.id} style={{ justifyContent: "flex-start", opacity: c.active ? 1 : 0.5 }}>
                  {c.name}{c.active ? "" : " (arquivado)"}
                </Link>
              ))}
              <form action={createCarousel}>
                <input type="hidden" name="brand" value={b} />
                <button className="btn small" type="submit">+ Novo carrossel {BRAND[b]}</button>
              </form>
            </div>
          ))}
        </aside>
        {selected ? (
          <CarouselEditor
            key={selected.id}
            carousel={selected}
            members={(resumo.data ?? []) as MemberRow[]}
            closers={(closers.data ?? []) as { id: string; name: string }[]}
            periodLabel={period ? months.find((m) => m.key === period)!.label : "Semana atual"}
          />
        ) : <p className="muted">Nenhum carrossel cadastrado.</p>}
      </div>
    </main>
  );
}
