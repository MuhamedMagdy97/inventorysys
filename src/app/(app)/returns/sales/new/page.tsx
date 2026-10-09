import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/app/ui/action-form";
import { Denied } from "@/app/ui/denied";
import { pageData } from "@/server/auth/page-ctx";
import { returnableOrderLines } from "@/server/returns/sales-returns";
import { createSalesReturnAction } from "../../actions";

export const metadata: Metadata = { title: "New customer return" };

// Flow 16 request: find the order, enter what comes back per fulfilled order line (SR-01).
export default async function NewSalesReturnPage({ searchParams }: PageProps<"/returns/sales/new">) {
  const sp = await searchParams;
  const order = typeof sp.order === "string" && sp.order.trim() ? sp.order.trim() : undefined;
  const res = await pageData((ctx) => returnableOrderLines(ctx, { externalOrderId: order }));
  if ("denied" in res) return <Denied message={res.denied} />;
  const lines = res.data.filter((l) => Number(l.returnable) > 0);
  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <div>
        <Link href="/returns" className="link text-sm">← Returns</Link>
        <h1 className="h1 mt-1">New customer return</h1>
      </div>
      <form className="flex items-end gap-3" role="search">
        <label className="label">External order id<input name="order" defaultValue={order} className="input" /></label>
        <button className="btn">Find</button>
      </form>
      <section className="card">
        <ActionForm action={createSalesReturnAction} submit="Request return">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="label">Reason code<input name="reasonCode" required maxLength={50} placeholder="wrong_size, defective…" className="input" /></label>
            <label className="label">Note<input name="note" className="input" /></label>
          </div>
          <div className="overflow-x-auto">
            <table className="table">
              <thead><tr><th>Order</th><th>SKU</th><th>Warehouse</th><th className="text-right">Fulfilled</th><th className="text-right">Returnable</th><th>Return qty</th><th>Serials</th></tr></thead>
              <tbody>
                {lines.length === 0 && <tr><td colSpan={7} className="text-muted">No fulfilled order lines with units left to return.</td></tr>}
                {lines.map((l) => (
                  <tr key={l.id}>
                    <td className="text-xs">{l.order ? `${l.order.channel} · ${l.order.externalOrderId}` : l.id.slice(0, 8)}</td>
                    <td className="font-mono text-xs">{l.variant.sku}</td><td>{l.warehouse.code}</td>
                    <td className="text-right tabular-nums">{l.qtyFulfilled.toString()}</td><td className="text-right tabular-nums">{l.returnable}</td>
                    <td><input name={`qty.${l.id}`} inputMode="decimal" aria-label={`Return qty ${l.variant.sku}`} className="input w-20" /></td>
                    <td><input name={`serials.${l.id}`} aria-label={`Serials ${l.variant.sku}`} className="input w-40" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted">Returned units go to quarantine on receipt and become sellable only after an inspection pass.</p>
        </ActionForm>
      </section>
    </div>
  );
}
