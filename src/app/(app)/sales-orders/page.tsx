import type { Metadata } from "next";
import Link from "next/link";
import type { ReservationStatus } from "@/generated/prisma/client";
import { ActionForm } from "@/app/ui/action-form";
import { Denied } from "@/app/ui/denied";
import { pageData } from "@/server/auth/page-ctx";
import { lookupCodes } from "@/server/catalog/catalog";
import { scopeFilter } from "@/server/core/ctx";
import { db } from "@/server/db";
import { getAvailability } from "@/server/inventory/availability";
import { listReservations, orderStatus } from "@/server/sales/orders";
import { cancelOrderAction, reservationAction, reserveAction } from "./actions";

export const metadata: Metadata = { title: "Sales orders" };

const STATUSES: ReservationStatus[] = ["active", "partially_fulfilled", "fulfilled", "cancelled", "expired"];
const n = (d: { toString(): string }) => Number(d.toString()).toLocaleString(undefined, { maximumFractionDigits: 4 });
const one = (v: string | string[] | undefined) => (typeof v === "string" && v ? v : undefined);

// Doc 25 "Sales Orders (refs)": reservations with fulfil/cancel/extend, ATP inline.
export default async function SalesOrdersPage({ searchParams }: PageProps<"/sales-orders">) {
  const sp = await searchParams;
  const q = one(sp.q), order = one(sp.order), reservation = one(sp.reservation), sku = one(sp.sku);
  const status = STATUSES.find((s) => s === sp.status);
  const res = await pageData(async (ctx) => {
    const list = await listReservations(ctx, { q, status, orderId: order, reservationId: reservation, perPage: 100 });
    // ATP per variant × warehouse shown. ponytail: one query pair per pair; fine for 100 rows.
    const pairs = [...new Map(list.items.map((r) => [`${r.variantId}|${r.warehouseId}`, r])).values()];
    const atp = new Map(await Promise.all(pairs.map(async (r) =>
      [`${r.variantId}|${r.warehouseId}`, (await getAvailability(ctx, { variantId: r.variantId, warehouseId: r.warehouseId })).available] as const)));
    const warehouses = await db.warehouse.findMany({
      where: { companyId: ctx.companyId, status: "active", id: scopeFilter(ctx) }, orderBy: { code: "asc" }, select: { id: true, code: true },
    });
    const ref = order ? await db.salesOrderRef.findFirst({ where: { id: order, companyId: ctx.companyId } }) : null;
    let check: { sku: string; error?: string; atp?: Awaited<ReturnType<typeof getAvailability>> } | null = null;
    if (sku) {
      const [hit] = await lookupCodes(ctx, [sku]);
      check = hit?.result === "found"
        ? { sku, atp: await getAvailability(ctx, { variantId: hit.matches[0].variantId }) }
        : { sku, error: hit?.result === "ambiguous" ? "Matches more than one item; enter the exact SKU" : "SKU not found" };
    }
    return { list, atp, warehouses, ref, check };
  });
  if ("denied" in res) return <Denied message={res.denied} />;
  const { list, atp, warehouses, ref, check } = res.data;
  const can = (p: string) => res.ctx.permissions.has(p);
  const whCode = new Map(warehouses.map((w) => [w.id, w.code]));
  const key = crypto.randomUUID();

  return (
    <div className="flex max-w-6xl flex-col gap-6">
      <h1 className="h1">Sales orders</h1>

      {ref && (
        <section className="card flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="font-semibold">Order {ref.externalOrderId}</h2>
            <p className="text-sm text-muted">{ref.channel} · {orderStatus(list.items)} · since {ref.createdAt.toISOString().slice(0, 16).replace("T", " ")}</p>
          </div>
          {orderStatus(list.items) === "open" && can("sales.cancel") && (
            <ActionForm action={cancelOrderAction.bind(null, ref.id)} submit="Cancel order" className="flex items-end gap-2">
              <label className="label">Reason<input name="reason" placeholder="payment_failed" className="input" /></label>
            </ActionForm>
          )}
        </section>
      )}

      {can("sales.reserve") && (
        <section className="card flex flex-col gap-4">
          <h2 className="font-semibold">Check availability · reserve</h2>
          <form className="flex flex-wrap items-end gap-3" role="search">
            <label className="label">SKU or barcode<input name="sku" defaultValue={sku} className="input" /></label>
            <button className="btn">Check ATP</button>
          </form>
          {check?.error && <p role="alert" className="text-sm text-red-600">{check.sku}: {check.error}</p>}
          {check?.atp && (
            <p className="text-sm">
              <span className="font-mono">{check.atp.sku}</span> available: <strong>{n(check.atp.available)}</strong>
              {" "}({[...new Set(check.atp.positions.map((p) => p.warehouseId))].map((w) => {
                const sumW = check.atp!.positions.filter((p) => p.warehouseId === w).reduce((s, p) => s + Number(p.available), 0);
                return `${whCode.get(w) ?? "?"} ${sumW}`;
              }).join(" · ") || "no stock"})
            </p>
          )}
          <ActionForm action={reserveAction.bind(null, key)} submit="Reserve / sell">
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="label">SKU or barcode<input name="sku" defaultValue={check?.atp?.sku ?? sku} required className="input" /></label>
              <label className="label">
                Warehouse
                <select name="warehouseId" required className="input">
                  {warehouses.map((w) => <option key={w.id} value={w.id}>{w.code}</option>)}
                </select>
              </label>
              <label className="label">Qty<input name="qty" type="number" min="0.0001" step="any" required className="input" /></label>
              <label className="label">Order number<input name="externalOrderId" maxLength={100} className="input" /></label>
              <label className="label">
                Channel
                <select name="channel" defaultValue="pos" className="input">
                  <option value="pos">POS</option><option value="web">Web</option><option value="marketplace">Marketplace</option><option value="api">API</option>
                </select>
              </label>
            </div>
            <div className="flex flex-wrap gap-4 text-sm">
              <label className="flex items-center gap-2"><input type="checkbox" name="allowPartial" /> Reserve what is available</label>
              {can("sales.fulfil") && <label className="flex items-center gap-2"><input type="checkbox" name="sellNow" /> Sell now (POS: reserve + ship)</label>}
            </div>
          </ActionForm>
        </section>
      )}

      <form className="flex flex-wrap items-end gap-3" role="search">
        <label className="label">Search<input name="q" defaultValue={q} placeholder="Order number or SKU" className="input" /></label>
        <label className="label">
          Status
          <select name="status" defaultValue={status ?? ""} className="input">
            <option value="">All</option>
            {STATUSES.map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}
          </select>
        </label>
        <button className="btn">Filter</button>
        {(order || reservation) && <Link href="/sales-orders" className="link text-sm">Clear</Link>}
      </form>

      <div className="card overflow-x-auto p-0">
        <table className="table">
          <thead>
            <tr>
              <th>Order</th><th>SKU</th><th>Wh</th><th className="text-right">Qty</th><th className="text-right">Shipped</th>
              <th className="text-right">Released</th><th>Status</th><th>Expires</th><th className="text-right">ATP now</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {list.items.length === 0 && <tr><td colSpan={10} className="text-muted">No reservations.</td></tr>}
            {list.items.map((r) => {
              const open = r.status === "active" || r.status === "partially_fulfilled";
              const v = <input type="hidden" name="version" value={r.version} />;
              return (
                <tr key={r.id}>
                  <td>{r.order ? <Link href={`/sales-orders?order=${r.order.id}`} className="link">{r.order.externalOrderId}</Link> : "—"}<span className="ml-1 text-xs text-muted">{r.order?.channel}</span></td>
                  <td className="font-mono text-xs">{r.variant.sku}{r.lines.some((l) => l.batch) && <span className="block text-muted">{r.lines.filter((l) => l.batch).map((l) => `${l.batch!.batchNo}×${n(l.qty)}`).join(", ")}</span>}</td>
                  <td>{r.warehouse.code}</td>
                  <td className="text-right tabular-nums">{n(r.qty)}</td>
                  <td className="text-right tabular-nums">{n(r.qtyFulfilled)}</td>
                  <td className="text-right tabular-nums">{n(r.qtyReleased)}</td>
                  <td>{r.status.replace("_", " ")}</td>
                  <td className="text-xs">{open ? r.expiresAt.toISOString().slice(0, 16).replace("T", " ") : "—"}{r.extendedAt && " (extended)"}</td>
                  <td className="text-right tabular-nums">{n(atp.get(`${r.variantId}|${r.warehouseId}`) ?? "0")}</td>
                  <td>
                    {open && (
                      <div className="flex flex-col gap-1">
                        {can("sales.fulfil") && (
                          <ActionForm action={reservationAction.bind(null, r.id, "fulfil")} submit="Ship" className="flex items-center gap-1">
                            {v}<input name="qty" type="number" min="0.0001" step="any" placeholder="all" aria-label="Quantity to ship" className="input w-20" />
                          </ActionForm>
                        )}
                        {can("sales.cancel") && <ActionForm action={reservationAction.bind(null, r.id, "cancel")} submit="Cancel" className="flex gap-1">{v}</ActionForm>}
                        {can("sales.reserve") && !r.extendedAt && <ActionForm action={reservationAction.bind(null, r.id, "extend")} submit="Extend" className="flex gap-1">{v}</ActionForm>}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {list.total > list.items.length && <p className="text-sm text-muted">Showing {list.items.length} of {list.total}; narrow the search.</p>}
    </div>
  );
}
