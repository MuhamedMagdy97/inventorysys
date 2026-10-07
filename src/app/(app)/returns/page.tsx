import type { Metadata } from "next";
import Link from "next/link";
import { Denied } from "@/app/ui/denied";
import { pageData } from "@/server/auth/page-ctx";
import { listPurchaseReturns } from "@/server/returns/purchase-returns";
import { listSalesReturns } from "@/server/returns/sales-returns";

export const metadata: Metadata = { title: "Returns" };

const label = (s: string) => s.replaceAll("_", " ");
const day = (d: Date) => d.toISOString().slice(0, 10);

// Doc 25 Returns: both flows, newest first. ponytail: one page of 100 each; filters when lists grow.
export default async function ReturnsPage() {
  const res = await pageData(async (ctx) => {
    const has = (p: string) => ctx.permissions.has(p);
    const [purchase, sales] = await Promise.all([
      has("purchases.view") || has("purchases.return_ship") ? listPurchaseReturns(ctx, { page: 1, perPage: 100 }) : null,
      has("sales.view") ? listSalesReturns(ctx, { page: 1, perPage: 100 }) : null,
    ]);
    return { purchase, sales, canPr: has("purchases.return_create"), canSr: has("sales.return_create") };
  });
  if ("denied" in res) return <Denied message={res.denied} />;
  const { purchase, sales, canPr, canSr } = res.data;
  return (
    <div className="flex max-w-6xl flex-col gap-8">
      <h1 className="h1">Returns</h1>
      {purchase && (
        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">To suppliers</h2>
            {canPr && <Link href="/returns/purchase/new" className="btn-primary">New supplier return</Link>}
          </div>
          <div className="card overflow-x-auto p-0">
            <table className="table">
              <thead><tr><th>Number</th><th>Supplier</th><th>PO</th><th>Warehouse</th><th>Reason</th><th>Status</th><th className="text-right">Lines</th><th>Created</th></tr></thead>
              <tbody>
                {purchase.items.length === 0 && <tr><td colSpan={8} className="text-muted">Nothing here.</td></tr>}
                {purchase.items.map((r) => (
                  <tr key={r.id}>
                    <td><Link href={`/returns/purchase/${r.id}`} className="link font-mono text-xs">{r.number}</Link></td>
                    <td>{r.supplier.name}</td><td className="font-mono text-xs">{r.po.number}</td><td>{r.warehouse.code}</td>
                    <td>{r.reasonCode}</td><td>{label(r.status)}</td><td className="text-right tabular-nums">{r._count.lines}</td><td>{day(r.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {sales && (
        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">From customers</h2>
            {canSr && <Link href="/returns/sales/new" className="btn-primary">New customer return</Link>}
          </div>
          <div className="card overflow-x-auto p-0">
            <table className="table">
              <thead><tr><th>Number</th><th>Warehouse</th><th>Reason</th><th>Status</th><th className="text-right">Lines</th><th>Created</th></tr></thead>
              <tbody>
                {sales.items.length === 0 && <tr><td colSpan={6} className="text-muted">Nothing here.</td></tr>}
                {sales.items.map((r) => (
                  <tr key={r.id}>
                    <td><Link href={`/returns/sales/${r.id}`} className="link font-mono text-xs">{r.number}</Link></td>
                    <td>{r.warehouse.code}</td><td>{r.reasonCode}</td><td>{label(r.status)}</td>
                    <td className="text-right tabular-nums">{r._count.lines}</td><td>{day(r.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
