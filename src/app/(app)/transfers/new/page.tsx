import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/app/ui/action-form";
import { Denied } from "@/app/ui/denied";
import { pageData } from "@/server/auth/page-ctx";
import { requirePermission } from "@/server/core/ctx";
import { db } from "@/server/db";
import { createTransferAction } from "../actions";

export const metadata: Metadata = { title: "New transfer" };

// Flow 9. Any active warehouse can be the other end; the domain checks your scope covers one end.
export default async function NewTransferPage() {
  const res = await pageData(async (ctx) => {
    await requirePermission(ctx, "inventory.transfer_create");
    return db.warehouse.findMany({ where: { companyId: ctx.companyId, status: "active" }, orderBy: { code: "asc" }, select: { id: true, code: true, name: true } });
  });
  if ("denied" in res) return <Denied message={res.denied} />;
  const warehouses = res.data;
  const options = warehouses.map((w) => <option key={w.id} value={w.id}>{w.code} · {w.name}</option>);
  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <div>
        <Link href="/transfers" className="link text-sm">← Transfers</Link>
        <h1 className="h1 mt-1">New transfer</h1>
      </div>
      <section className="card">
        <ActionForm action={createTransferAction} submit="Create draft">
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="label">From<select name="fromWarehouseId" required className="input">{options}</select></label>
            <label className="label">To<select name="toWarehouseId" required defaultValue={warehouses[1]?.id} className="input">{options}</select></label>
            <label className="label">Notes<input name="notes" className="input" /></label>
          </div>
          <div className="overflow-x-auto">
            <table className="table">
              <thead><tr><th>SKU / barcode</th><th>Qty (base units)</th><th>Batch no. (batch-tracked items)</th></tr></thead>
              <tbody>
                {Array.from({ length: 8 }, (_, i) => (
                  <tr key={i}>
                    <td><input name={`line.${i}.sku`} aria-label={`Line ${i + 1} SKU`} className="input w-40 font-mono" /></td>
                    <td><input name={`line.${i}.qty`} inputMode="decimal" aria-label={`Line ${i + 1} quantity`} className="input w-24" /></td>
                    <td><input name={`line.${i}.batchNo`} aria-label={`Line ${i + 1} batch`} className="input w-32" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted">Availability at the source is checked again when the transfer ships.</p>
        </ActionForm>
      </section>
    </div>
  );
}
