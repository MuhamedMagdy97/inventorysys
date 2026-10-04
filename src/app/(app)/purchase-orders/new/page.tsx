import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/app/ui/action-form";
import { Denied } from "@/app/ui/denied";
import { pageData } from "@/server/auth/page-ctx";
import { requirePermission } from "@/server/core/ctx";
import { db } from "@/server/db";
import { createPoAction } from "../actions";
import { LineRows } from "../line-rows";

export const metadata: Metadata = { title: "New purchase order" };

export default async function NewPoPage() {
  const res = await pageData(async (ctx) => {
    await requirePermission(ctx, "purchases.create");
    const [suppliers, warehouses] = await Promise.all([
      db.supplier.findMany({ where: { companyId: ctx.companyId, status: "active" }, orderBy: { name: "asc" }, select: { id: true, code: true, name: true, currency: true } }),
      db.warehouse.findMany({ where: { companyId: ctx.companyId, status: "active" }, orderBy: { code: "asc" }, select: { id: true, code: true, name: true } }),
    ]);
    return { suppliers, warehouses };
  });
  if ("denied" in res) return <Denied message={res.denied} />;
  const { suppliers, warehouses } = res.data;
  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <div>
        <Link href="/purchase-orders" className="link text-sm">← Purchase orders</Link>
        <h1 className="h1 mt-1">New purchase order</h1>
      </div>
      <section className="card">
        <ActionForm action={createPoAction} submit="Create draft">
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="label">
              Supplier
              <select name="supplierId" required className="input">
                {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.code}, {s.currency})</option>)}
              </select>
            </label>
            <label className="label">
              Receiving warehouse
              <select name="warehouseId" required className="input">
                {warehouses.map((w) => <option key={w.id} value={w.id}>{w.code} · {w.name}</option>)}
              </select>
            </label>
            <label className="label">Expected date<input name="expectedDate" type="date" className="input" /></label>
          </div>
          <LineRows blank={8} />
          <div className="grid gap-3 sm:grid-cols-4">
            <label className="label">Header discount<input name="discount" inputMode="decimal" className="input" /></label>
            <label className="label">Tax<input name="tax" inputMode="decimal" className="input" /></label>
            <label className="label">Shipping<input name="shipping" inputMode="decimal" className="input" /></label>
            <label className="label">Notes<input name="notes" className="input" /></label>
          </div>
          <p className="text-xs text-muted">Leave the price blank to use the supplier&apos;s last price (or the item&apos;s cost price). One PO receives into one warehouse.</p>
        </ActionForm>
      </section>
    </div>
  );
}
