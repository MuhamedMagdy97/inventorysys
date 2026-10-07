import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/app/ui/action-form";
import { Denied } from "@/app/ui/denied";
import { pageData } from "@/server/auth/page-ctx";
import { requirePermission } from "@/server/core/ctx";
import { db } from "@/server/db";
import { createAdjustmentAction } from "../actions";

export const metadata: Metadata = { title: "New adjustment" };

export default async function NewAdjustmentPage() {
  const res = await pageData(async (ctx) => {
    await requirePermission(ctx, ["inventory.adjust_create", "inventory.damage_mark"]);
    return db.warehouse.findMany({
      where: { companyId: ctx.companyId, status: "active", ...(ctx.warehouseIds === "all" ? {} : { id: { in: ctx.warehouseIds } }) },
      orderBy: { code: "asc" }, select: { id: true, code: true, name: true },
    });
  });
  if ("denied" in res) return <Denied message={res.denied} />;
  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <div>
        <Link href="/adjustments" className="link text-sm">← Adjustments</Link>
        <h1 className="h1 mt-1">New adjustment, damage, repair or disposal</h1>
      </div>
      <section className="card">
        <ActionForm action={createAdjustmentAction} submit="Create draft">
          <div className="grid gap-3 sm:grid-cols-4">
            <label className="label">
              Kind
              <select name="kind" className="input">
                <option value="adjustment">Adjustment (± on hand)</option>
                <option value="damage">Mark damaged</option>
                <option value="repair">Repair to stock</option>
                <option value="disposal">Dispose (write off)</option>
              </select>
            </label>
            <label className="label">Warehouse<select name="warehouseId" required className="input">{res.data.map((w) => <option key={w.id} value={w.id}>{w.code} · {w.name}</option>)}</select></label>
            <label className="label">Reason code<input name="reasonCode" required maxLength={50} placeholder="found, loss, dropped…" className="input" /></label>
            <label className="label">Note / evidence<input name="note" className="input" /></label>
          </div>
          <div className="overflow-x-auto">
            <table className="table">
              <thead><tr><th>SKU / barcode</th><th>Qty</th><th>Batch no.</th><th>Bin code</th><th>Bucket (disposal)</th><th>Unit cost (found)</th><th>Serials</th></tr></thead>
              <tbody>
                {Array.from({ length: 6 }, (_, i) => {
                  const p = `line.${i}.`;
                  return (
                    <tr key={i}>
                      <td><input name={p + "sku"} aria-label={`Line ${i + 1} SKU`} className="input w-36 font-mono" /></td>
                      <td><input name={p + "qty"} inputMode="decimal" aria-label={`Line ${i + 1} quantity`} className="input w-20" /></td>
                      <td><input name={p + "batchNo"} aria-label={`Line ${i + 1} batch`} className="input w-24" /></td>
                      <td><input name={p + "bin"} placeholder="auto" aria-label={`Line ${i + 1} bin`} className="input w-20" /></td>
                      <td>
                        <select name={p + "bucket"} aria-label={`Line ${i + 1} bucket`} className="input">
                          <option>damaged</option><option>expired</option><option>blocked</option>
                        </select>
                      </td>
                      <td><input name={p + "unitCost"} inputMode="decimal" placeholder="WAC" aria-label={`Line ${i + 1} unit cost`} className="input w-20" /></td>
                      <td><input name={p + "serials"} aria-label={`Line ${i + 1} serials`} className="input w-32" /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted">Adjustments: positive qty = found, negative = loss. Damage, repair and disposal take positive quantities and apply when approved.</p>
        </ActionForm>
      </section>
    </div>
  );
}
