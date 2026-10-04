import type { Metadata } from "next";
import Link from "next/link";
import type { PoStatus } from "@/generated/prisma/client";
import { Denied } from "@/app/ui/denied";
import { pageData } from "@/server/auth/page-ctx";
import { listPos } from "@/server/purchasing/purchase-orders";
import { listPendingExcess } from "@/server/purchasing/receipts";

export const metadata: Metadata = { title: "Purchase orders" };

const STATUSES: PoStatus[] = ["draft", "submitted", "approved", "ordered", "partially_received", "fully_received", "closed", "cancelled"];

export default async function PurchaseOrdersPage({ searchParams }: PageProps<"/purchase-orders">) {
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q : undefined;
  const status = STATUSES.find((s) => s === sp.status);
  const res = await pageData(async (ctx) => ({
    list: await listPos(ctx, { page: 1, perPage: 200, q, status }), // ponytail: one page; paginate past 200 POs per filter
    excess: ctx.permissions.has("purchases.approve") ? await listPendingExcess(ctx) : [],
    canCreate: ctx.permissions.has("purchases.create"),
  }));
  if ("denied" in res) return <Denied message={res.denied} />;
  const { list, excess, canCreate } = res.data;
  return (
    <div className="flex max-w-6xl flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="h1">Purchase orders</h1>
        {canCreate && <Link href="/purchase-orders/new" className="btn-primary">New PO</Link>}
      </div>
      {excess.length > 0 && (
        <section className="card border-amber-500">
          <h2 className="mb-2 font-semibold">Over-deliveries awaiting a decision</h2>
          <ul className="text-sm">
            {excess.map((x) => (
              <li key={x.id}>
                <Link href={`/purchase-orders/${x.receipt.po.id}`} className="link">{x.receipt.po.number}</Link> · {x.receipt.number} · {x.variant.sku} · {x.qtyExcessBlocked.toString()} blocked · {x.receipt.po.supplierName}
              </li>
            ))}
          </ul>
        </section>
      )}
      <form className="flex flex-wrap items-end gap-3" role="search">
        <label className="label">Search<input name="q" defaultValue={q} placeholder="PO number or supplier" className="input" /></label>
        <label className="label">
          Status
          <select name="status" defaultValue={status ?? ""} className="input">
            <option value="">All</option>
            {STATUSES.map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}
          </select>
        </label>
        <button className="btn">Filter</button>
      </form>
      <div className="card overflow-x-auto p-0">
        <table className="table">
          <thead><tr><th>PO</th><th>Supplier</th><th>Warehouse</th><th>Status</th><th className="text-right">Lines</th><th className="text-right">Total</th><th>Expected</th></tr></thead>
          <tbody>
            {list.items.length === 0 && <tr><td colSpan={7} className="text-muted">No purchase orders.</td></tr>}
            {list.items.map((po) => (
              <tr key={po.id}>
                <td><Link href={`/purchase-orders/${po.id}`} className="link font-mono text-xs">{po.number}</Link></td>
                <td>{po.supplierName}</td>
                <td>{po.warehouse.code}</td>
                <td>{po.status.replace("_", " ")}</td>
                <td className="text-right tabular-nums">{po._count.lines}</td>
                <td className="text-right tabular-nums">{po.total.toFixed(2)} {po.currency}</td>
                <td>{po.expectedDate?.toISOString().slice(0, 10) ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
