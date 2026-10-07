import type { Metadata } from "next";
import Link from "next/link";
import type { CountStatus } from "@/generated/prisma/client";
import { ActionForm } from "@/app/ui/action-form";
import { Denied } from "@/app/ui/denied";
import { pageData } from "@/server/auth/page-ctx";
import { db } from "@/server/db";
import { listCounts } from "@/server/inventory/counts";
import { openCountAction } from "./actions";

export const metadata: Metadata = { title: "Stock counts" };

const STATUSES: CountStatus[] = ["open", "counting", "variance_review", "approved", "applied", "cancelled"];

export default async function CountsPage({ searchParams }: PageProps<"/counts">) {
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q : undefined;
  const status = STATUSES.find((s) => s === sp.status);
  const res = await pageData(async (ctx) => ({
    list: await listCounts(ctx, { page: 1, perPage: 200, q, status }), // ponytail: one page; paginate past 200
    warehouses: ctx.permissions.has("inventory.count_create")
      ? await db.warehouse.findMany({
        where: { companyId: ctx.companyId, status: "active", ...(ctx.warehouseIds === "all" ? {} : { id: { in: ctx.warehouseIds } }) },
        orderBy: { code: "asc" }, select: { id: true, code: true, name: true },
      })
      : [],
  }));
  if ("denied" in res) return <Denied message={res.denied} />;
  const { list, warehouses } = res.data;
  return (
    <div className="flex max-w-6xl flex-col gap-6">
      <h1 className="h1">Stock counts</h1>
      {warehouses.length > 0 && (
        <section className="card">
          <h2 className="mb-2 font-semibold">Open a count</h2>
          <ActionForm action={openCountAction} submit="Open (take snapshot)" className="flex flex-wrap items-end gap-3">
            <label className="label">Warehouse<select name="warehouseId" required className="input">{warehouses.map((w) => <option key={w.id} value={w.id}>{w.code} · {w.name}</option>)}</select></label>
            <label className="label">Bin code (optional)<input name="bin" className="input w-28" placeholder="all bins" /></label>
            <label className="label">SKUs / barcodes (optional)<input name="skus" className="input w-64" placeholder="all items; separate with spaces" /></label>
            <label className="label">Note<input name="note" className="input" /></label>
          </ActionForm>
          <p className="mt-2 text-xs text-muted">Postings continue while you count; each entry records the system quantity at that moment, and the difference is applied later under lock.</p>
        </section>
      )}
      <form className="flex flex-wrap items-end gap-3" role="search">
        <label className="label">Search<input name="q" defaultValue={q} placeholder="CNT number" className="input" /></label>
        <label className="label">
          Status
          <select name="status" defaultValue={status ?? ""} className="input"><option value="">All</option>{STATUSES.map((s) => <option key={s}>{s}</option>)}</select>
        </label>
        <button className="btn">Filter</button>
      </form>
      <div className="card overflow-x-auto p-0">
        <table className="table">
          <thead><tr><th>Number</th><th>Warehouse</th><th>Bin</th><th>Status</th><th className="text-right">Lines</th><th>Snapshot</th></tr></thead>
          <tbody>
            {list.items.length === 0 && <tr><td colSpan={6} className="text-muted">Nothing here.</td></tr>}
            {list.items.map((c) => (
              <tr key={c.id}>
                <td><Link href={`/counts/${c.id}`} className="link font-mono text-xs">{c.number}</Link></td>
                <td>{c.warehouse.code}</td>
                <td>{c.bin?.code ?? "all"}</td>
                <td>{c.status}</td>
                <td className="text-right tabular-nums">{c._count.lines}</td>
                <td>{c.snapshotAt.toISOString().slice(0, 16).replace("T", " ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
