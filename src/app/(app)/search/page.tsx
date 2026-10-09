import type { Metadata } from "next";
import Link from "next/link";
import { pageCtx } from "@/server/auth/page-ctx";
import { AppError } from "@/server/core/errors";
import { search, type Hit } from "@/server/search/search";

export const metadata: Metadata = { title: "Search" };

// Doc 25 global search, scoped to the caller's grants and warehouses.
export default async function SearchPage({ searchParams }: PageProps<"/search">) {
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q : "";
  const ctx = await pageCtx();
  let hits: Hit[] = [], error: string | null = null;
  if (q) {
    try {
      hits = (await search(ctx, { q })).hits;
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
      error = e.message;
    }
  }
  const groups = Map.groupBy(hits, (h) => h.group);
  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <h1 className="h1">Search</h1>
      <form className="flex gap-2">
        <input name="q" defaultValue={q} placeholder="SKU, barcode, PO, order, batch, serial, supplier, warehouse, user" className="input" autoFocus />
        <button className="btn-primary">Search</button>
      </form>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {q && !error && hits.length === 0 && <p className="text-sm text-muted">No matches you have access to.</p>}
      {[...groups.entries()].map(([g, items]) => (
        <section key={g} className="card">
          <h2 className="mb-2 font-semibold">{g}</h2>
          <ul className="flex flex-col gap-1 text-sm">
            {items.map((h) => <li key={h.link + h.label}><Link href={h.link} className="link">{h.label}</Link> <span className="text-muted">{h.detail}</span></li>)}
          </ul>
        </section>
      ))}
    </div>
  );
}
