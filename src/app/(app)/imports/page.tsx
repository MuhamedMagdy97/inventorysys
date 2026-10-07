import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/app/ui/action-form";
import { Denied } from "@/app/ui/denied";
import { pageData } from "@/server/auth/page-ctx";
import { db } from "@/server/db";
import { listImports } from "@/server/imports/imports";
import { uploadImportAction } from "./actions";

export const metadata: Metadata = { title: "Import / export" };

export default async function ImportsPage() {
  const res = await pageData(async (ctx) => ({
    imports: ctx.permissions.has("imports.run") ? await listImports(ctx, { page: 1, perPage: 100 }) : null, // ponytail: last 100
    canExport: ctx.permissions.has("reports.export") && ctx.permissions.has("inventory.view"),
    warehouses: await db.warehouse.findMany({
      where: { companyId: ctx.companyId, status: "active", ...(ctx.warehouseIds === "all" ? {} : { id: { in: ctx.warehouseIds } }) },
      orderBy: { code: "asc" }, select: { id: true, code: true, name: true },
    }),
  }));
  if ("denied" in res) return <Denied message={res.denied} />;
  const { imports, canExport, warehouses } = res.data;
  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <h1 className="h1">Import / export</h1>

      {imports && (
        <section className="card">
          <h2 className="mb-2 font-semibold">Import (preview first)</h2>
          <ActionForm action={uploadImportAction} submit="Upload & preview" className="flex flex-col gap-3">
            <div className="flex flex-wrap items-end gap-3">
              <label className="label">
                Type
                <select name="type" className="input">
                  <option value="products">Products (one SKU per row)</option>
                  <option value="opening_balance">Opening balance</option>
                </select>
              </label>
              <label className="label">File (.csv or .xlsx, ≤ 5 MB)<input name="file" type="file" accept=".csv,.xlsx" required className="input" /></label>
              <label className="label">Warehouse (opening)<select name="warehouseId" className="input"><option value="">—</option>{warehouses.map((w) => <option key={w.id} value={w.id}>{w.code} · {w.name}</option>)}</select></label>
              <label className="label">As of (opening)<input name="asOf" type="datetime-local" className="input" /></label>
            </div>
            <p className="text-xs text-muted">
              Products columns: <code>sku, name</code> + optional <code>barcode, base_uom, requires_batch, requires_expiry, is_serialized, cost_price, sell_price, min_sell_price</code>.
              Opening balance: <code>sku, qty, unit_cost</code> + optional <code>bin, batch_no, expiry_date, serials</code>; it becomes one opening document that a second person approves.
            </p>
          </ActionForm>
        </section>
      )}

      {canExport && (
        <section className="card">
          <h2 className="mb-2 font-semibold">Export stock (CSV)</h2>
          <form action="/api/exports/stock" method="get" className="flex flex-wrap items-end gap-3">
            <label className="label">Warehouse<select name="warehouseId" className="input"><option value="">All I can see</option>{warehouses.map((w) => <option key={w.id} value={w.id}>{w.code}</option>)}</select></label>
            <button className="btn">Download</button>
          </form>
          <p className="mt-2 text-xs text-muted">Every export is recorded in the audit log.</p>
        </section>
      )}

      {imports && (
        <section className="card overflow-x-auto p-0">
          <table className="table">
            <thead><tr><th>When</th><th>Type</th><th>File</th><th>Status</th><th className="text-right">Rows</th><th className="text-right">Errors</th><th>By</th></tr></thead>
            <tbody>
              {imports.items.length === 0 && <tr><td colSpan={7} className="text-muted">No imports yet.</td></tr>}
              {imports.items.map((j) => (
                <tr key={j.id}>
                  <td><Link href={`/imports/${j.id}`} className="link">{j.createdAt.toISOString().slice(0, 16).replace("T", " ")}</Link></td>
                  <td>{j.type}</td><td>{j.fileName}</td><td>{j.status}{j.mode && ` (${j.mode})`}</td>
                  <td className="text-right tabular-nums">{j.rowCount}</td>
                  <td className="text-right tabular-nums">{j.errorCount}</td>
                  <td>{j.creator.name}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
