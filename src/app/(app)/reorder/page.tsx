import type { Metadata } from "next";
import { ActionForm } from "@/app/ui/action-form";
import { Denied } from "@/app/ui/denied";
import { pageData } from "@/server/auth/page-ctx";
import { db } from "@/server/db";
import { listReorderSuggestions } from "@/server/purchasing/reorder";
import { createReorderPosAction } from "./actions";

export const metadata: Metadata = { title: "Reorder" };

// Doc 09 §6: suggestions only; nothing is ordered until the user ticks rows and submits (INV-016).
export default async function ReorderPage({ searchParams }: PageProps<"/reorder">) {
  const sp = await searchParams;
  const warehouseId = typeof sp.warehouseId === "string" && sp.warehouseId ? sp.warehouseId : undefined;
  const res = await pageData(async (ctx) => {
    const rows = await listReorderSuggestions(ctx, { warehouseId }); // checks purchases.create + scope
    const [warehouses, suppliers] = await Promise.all([
      db.warehouse.findMany({
        where: { companyId: ctx.companyId, status: "active", ...(ctx.warehouseIds === "all" ? {} : { id: { in: ctx.warehouseIds } }) },
        orderBy: { code: "asc" }, select: { id: true, code: true },
      }),
      db.supplier.findMany({ where: { companyId: ctx.companyId, status: "active" }, orderBy: { name: "asc" }, select: { id: true, name: true, currency: true } }),
    ]);
    return { rows, warehouses, suppliers };
  });
  if ("denied" in res) return <Denied message={res.denied} />;
  const { rows, warehouses, suppliers } = res.data;
  return (
    <div className="flex max-w-6xl flex-col gap-6">
      <h1 className="h1">Reorder suggestions</h1>
      <form className="flex flex-wrap items-end gap-3">
        <label className="label">
          Warehouse
          <select name="warehouseId" defaultValue={warehouseId ?? ""} className="input">
            <option value="">All in my scope</option>
            {warehouses.map((w) => <option key={w.id} value={w.id}>{w.code}</option>)}
          </select>
        </label>
        <button className="btn">Filter</button>
      </form>
      <p className="text-xs text-muted">
        Suggested when available + on order (open POs, drafts included) ≤ reorder point. Qty orders up to max stock, else the larger of
        reorder qty and the shortfall, raised to the supplier&apos;s minimum. Tick rows to create one draft PO per supplier and warehouse.
      </p>
      <ActionForm action={createReorderPosAction} submit="Create draft POs">
        <div className="card overflow-x-auto p-0">
          <table className="table">
            <thead>
              <tr>
                <th></th><th>SKU</th><th>Warehouse</th><th className="text-right">Available</th><th className="text-right">On order</th>
                <th className="text-right">Reorder pt</th><th>Supplier prices (cheapest first)</th><th>Order from</th><th>Qty</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={9} className="text-muted">Nothing to reorder.</td></tr>}
              {rows.map((r, i) => (
                <tr key={`${r.variantId}|${r.warehouseId}`}>
                  <td>
                    <input type="checkbox" name={`pick.${i}`} aria-label={`Order ${r.sku} for ${r.warehouseCode}`} />
                    <input type="hidden" name={`row.${i}.variantId`} value={r.variantId} />
                    <input type="hidden" name={`row.${i}.warehouseId`} value={r.warehouseId} />
                  </td>
                  <td><span className="font-mono text-xs">{r.sku}</span><div className="text-xs text-muted">{r.name}</div></td>
                  <td>{r.warehouseCode}</td>
                  <td className="text-right tabular-nums">{r.available}</td>
                  <td className="text-right tabular-nums">{r.onOrder}</td>
                  <td className="text-right tabular-nums">{r.reorderPoint}</td>
                  <td className="text-xs">
                    {r.suppliers.length === 0 ? "—" : r.suppliers.map((o) => (
                      <div key={o.supplierId}>
                        {o.name}: {o.lastPrice ?? "?"} {o.currency}{o.minOrderQty && ` · MOQ ${o.minOrderQty}`}{o.leadDays != null && ` · ${o.leadDays} d`}
                      </div>
                    ))}
                  </td>
                  <td>
                    <select name={`row.${i}.supplierId`} defaultValue={r.supplierId ?? ""} className="input">
                      <option value="">— choose —</option>
                      {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.currency})</option>)}
                    </select>
                  </td>
                  <td><input name={`row.${i}.qty`} defaultValue={r.suggestedQty} inputMode="decimal" className="input w-24" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ActionForm>
    </div>
  );
}
