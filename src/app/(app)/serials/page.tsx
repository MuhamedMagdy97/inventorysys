import type { Metadata } from "next";
import Link from "next/link";
import { SerialStatus } from "@/generated/prisma/client";
import { Denied } from "@/app/ui/denied";
import { pageData } from "@/server/auth/page-ctx";
import { scopeFilter } from "@/server/core/ctx";
import { db } from "@/server/db";
import { listSerials } from "@/server/inventory/tracking";

export const metadata: Metadata = { title: "Serials" };

const STATUSES = Object.values(SerialStatus);
const PER_PAGE = 50;
const one = (v: string | string[] | undefined) => (typeof v === "string" && v ? v : undefined);
const label = (s: string) => s.replaceAll("_", " ");

// Doc 25 "Serials": search + list; row → lifecycle.
export default async function SerialsPage({ searchParams }: PageProps<"/serials">) {
  const sp = await searchParams;
  const q = one(sp.q), variantId = one(sp.variantId), warehouseId = one(sp.warehouseId);
  const status = STATUSES.find((s) => s === sp.status);
  const page = Math.max(1, Number(one(sp.page)) || 1);
  const res = await pageData(async (ctx) => ({
    list: await listSerials(ctx, { q, variantId, status, warehouseId, page, perPage: PER_PAGE }),
    warehouses: await db.warehouse.findMany({ where: { companyId: ctx.companyId, id: scopeFilter(ctx) }, orderBy: { code: "asc" }, select: { id: true, code: true } }),
  }));
  if ("denied" in res) return <Denied message={res.denied} />;
  const { list, warehouses } = res.data;
  const more = new URLSearchParams(Object.entries({ q, variantId, warehouseId, status, page: String(page + 1) }).filter((e): e is [string, string] => !!e[1]));

  return (
    <div className="flex max-w-6xl flex-col gap-6">
      <h1 className="h1">Serials</h1>
      <form className="flex flex-wrap items-end gap-3" role="search">
        {variantId && <input type="hidden" name="variantId" value={variantId} />}
        <label className="label">Serial or SKU<input name="q" defaultValue={q} className="input font-mono" /></label>
        <label className="label">
          Status
          <select name="status" defaultValue={status ?? ""} className="input">
            <option value="">All</option>
            {STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}
          </select>
        </label>
        <label className="label">
          Warehouse
          <select name="warehouseId" defaultValue={warehouseId ?? ""} className="input">
            <option value="">All in my scope</option>
            {warehouses.map((w) => <option key={w.id} value={w.id}>{w.code}</option>)}
          </select>
        </label>
        <button className="btn">Search</button>
        {(q || variantId || status || warehouseId) && <Link href="/serials" className="link text-sm">Clear</Link>}
      </form>
      <div className="card overflow-x-auto p-0">
        <table className="table">
          <thead><tr><th>Serial</th><th>SKU</th><th>Batch</th><th>Status</th><th>Warehouse / bin</th><th>Last change</th></tr></thead>
          <tbody>
            {list.items.length === 0 && <tr><td colSpan={6} className="text-muted">No serial numbers match.</td></tr>}
            {list.items.map((u) => (
              <tr key={u.id}>
                <td><Link href={`/serials/${u.id}`} className="link font-mono text-xs">{u.serialNo}</Link></td>
                <td><Link href={`/products/${u.variant.productId}`} className="link font-mono text-xs">{u.variant.sku}</Link></td>
                <td className="font-mono text-xs">{u.batch?.batchNo ?? "—"}</td>
                <td>{label(u.status)}</td>
                <td>{u.warehouse.code}{u.bin && ` / ${u.bin.code}`}</td>
                <td className="whitespace-nowrap">{u.updatedAt.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {list.total > page * PER_PAGE && <Link href={`/serials?${more}`} className="link text-sm">Next page ({list.total} total)</Link>}
    </div>
  );
}
