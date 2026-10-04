import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/app/ui/action-form";
import { Denied } from "@/app/ui/denied";
import { pageData } from "@/server/auth/page-ctx";
import { db } from "@/server/db";
import { getPo } from "@/server/purchasing/purchase-orders";
import {
  cancelPoAction, closePoAction, excessAction, poMoveAction, reduceLineAction, rejectPoAction, reverseReceiptAction, updatePoAction,
} from "../actions";
import { LineRows } from "../line-rows";

export const metadata: Metadata = { title: "Purchase order" };

const n = (d: { toString(): string }) => Number(d.toString()).toLocaleString(undefined, { maximumFractionDigits: 4 });

export default async function PoPage({ params }: PageProps<"/purchase-orders/[id]">) {
  const { id } = await params;
  const res = await pageData(async (ctx) => {
    const po = await getPo(ctx, id);
    const suppliers = po.status === "draft" && ctx.permissions.has("purchases.update")
      ? await db.supplier.findMany({ where: { companyId: ctx.companyId, status: "active" }, orderBy: { name: "asc" }, select: { id: true, name: true } })
      : [];
    return { po, suppliers };
  });
  if ("denied" in res) return <Denied message={res.denied} />;
  const { po, suppliers } = res.data;
  const can = (p: string) => res.ctx.permissions.has(p);
  const lines = po.lines.filter((l) => !l.removed);
  const hasReceipts = po.receipts.length > 0;
  const reversed = new Set(po.receipts.map((r) => r.reversalOfReceiptId).filter(Boolean));
  const version = <input type="hidden" name="version" value={po.version} />;

  return (
    <div className="flex max-w-6xl flex-col gap-6">
      <div>
        <Link href="/purchase-orders" className="link text-sm">← Purchase orders</Link>
        <h1 className="h1 mt-1">{po.number}</h1>
        <p className="text-sm text-muted">
          {po.status.replace("_", " ")} · {po.supplier.name} ({po.supplier.code}) → {po.warehouse.code} · created by {po.creator.name}
          {po.expectedDate && ` · expected ${po.expectedDate.toISOString().slice(0, 10)}`}
        </p>
        {po.closeReason && <p className="text-sm">Reason: {po.closeReason}</p>}
      </div>

      <section className="flex flex-wrap gap-3">
        {po.canReceive && <Link href={`/purchase-orders/${po.id}/receive`} className="btn-primary">Receive goods</Link>}
        {po.status === "draft" && can("purchases.submit") && (
          <ActionForm action={poMoveAction.bind(null, po.id, "submit")} submit="Submit for approval" className="flex gap-2">{version}</ActionForm>
        )}
        {po.status === "submitted" && can("purchases.approve") && (
          <>
            <ActionForm action={poMoveAction.bind(null, po.id, "approve")} submit={`Approve ${po.total.toFixed(2)} ${po.currency}`} className="flex items-end gap-2">
              {version}<label className="label">Comment<input name="comment" className="input" /></label>
            </ActionForm>
            <ActionForm action={rejectPoAction.bind(null, po.id)} submit="Reject to draft" className="flex items-end gap-2">
              {version}<label className="label">Why<input name="comment" required className="input" /></label>
            </ActionForm>
          </>
        )}
        {po.status === "approved" && can("purchases.order") && (
          <ActionForm action={poMoveAction.bind(null, po.id, "order")} submit="Mark sent to supplier" className="flex gap-2">{version}</ActionForm>
        )}
        {["ordered", "partially_received", "fully_received"].includes(po.status) && can("purchases.close") && (
          <ActionForm action={closePoAction.bind(null, po.id)} submit="Close PO" className="flex items-end gap-2">
            {version}<label className="label">Reason (required with open remainder)<input name="reason" className="input" /></label>
          </ActionForm>
        )}
        {["draft", "submitted", "approved"].includes(po.status) && !hasReceipts && can("purchases.cancel") && (
          <ActionForm action={cancelPoAction.bind(null, po.id)} submit="Cancel PO" className="flex items-end gap-2">
            {version}<label className="label">Reason<input name="reason" className="input" /></label>
          </ActionForm>
        )}
      </section>

      {po.status === "draft" && can("purchases.update") ? (
        <section className="card">
          <h2 className="mb-3 font-semibold">Edit draft</h2>
          <ActionForm action={updatePoAction.bind(null, po.id)}>
            {version}
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="label">
                Supplier
                <select name="supplierId" defaultValue={po.supplierId} className="input">{suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
              </label>
              <label className="label">Expected date<input name="expectedDate" type="date" defaultValue={po.expectedDate?.toISOString().slice(0, 10)} className="input" /></label>
              <label className="label">Notes<input name="notes" defaultValue={po.notes ?? ""} className="input" /></label>
            </div>
            <LineRows lines={lines} blank={3} />
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="label">Header discount<input name="discount" defaultValue={po.discount.toString()} inputMode="decimal" className="input" /></label>
              <label className="label">Tax<input name="tax" defaultValue={po.tax.toString()} inputMode="decimal" className="input" /></label>
              <label className="label">Shipping<input name="shipping" defaultValue={po.shipping.toString()} inputMode="decimal" className="input" /></label>
            </div>
            <p className="text-xs text-muted">Clear a SKU to remove that line.</p>
          </ActionForm>
        </section>
      ) : (
        <section className="card overflow-x-auto p-0">
          <table className="table">
            <thead><tr><th>#</th><th>SKU</th><th>Item</th><th className="text-right">Ordered</th><th className="text-right">Received (base)</th><th className="text-right">Price</th><th className="text-right">Disc/Tax %</th><th className="text-right">Total</th><th /></tr></thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.id}>
                  <td>{l.lineNo}</td>
                  <td className="font-mono text-xs">{l.sku}</td>
                  <td>{l.name}</td>
                  <td className="text-right tabular-nums">{n(l.qtyOrdered)} {l.orderUom}{!l.uomFactor.eq(1) && <span className="text-muted"> (= {n(l.qtyOrderedBase)})</span>}</td>
                  <td className="text-right tabular-nums">{n(l.qtyReceivedBase)}</td>
                  <td className="text-right tabular-nums">{n(l.unitPrice)}</td>
                  <td className="text-right tabular-nums">{n(l.discountPct)} / {n(l.taxPct)}</td>
                  <td className="text-right tabular-nums">{l.lineTotal.toFixed(2)}</td>
                  <td>
                    {["approved", "ordered", "partially_received"].includes(po.status) && can("purchases.update") && (
                      <ActionForm action={reduceLineAction.bind(null, po.id, l.id)} submit="Reduce" className="flex items-center gap-1">
                        {version}<input name="qty" inputMode="decimal" aria-label={`New quantity for line ${l.lineNo}`} className="input w-20" />
                      </ActionForm>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="card text-sm">
        Subtotal {po.subtotal.toFixed(2)} − discount {po.discount.toFixed(2)} + tax {po.tax.toFixed(2)} + shipping {po.shipping.toFixed(2)} = <strong>{po.total.toFixed(2)} {po.currency}</strong>
      </section>

      {po.approvals.length > 0 && (
        <section className="card">
          <h2 className="mb-2 font-semibold">Approvals</h2>
          <ul className="text-sm">
            {po.approvals.map((a) => (
              <li key={a.id}>{a.createdAt.toISOString().slice(0, 16).replace("T", " ")} · {a.actor.name} · <strong>{a.decision}</strong> {a.amount.toFixed(2)}{a.comment && ` — ${a.comment}`}</li>
            ))}
          </ul>
        </section>
      )}

      {po.receipts.map((r) => (
        <section key={r.id} className="card flex flex-col gap-3">
          <h2 className="font-semibold">
            {r.number} {r.reversalOfReceiptId && <span className="text-muted">(reversal)</span>}{reversed.has(r.id) && <span className="text-muted"> (reversed)</span>}
          </h2>
          <p className="text-sm text-muted">{r.receivedAt.toISOString().slice(0, 16).replace("T", " ")} · {r.receiver.name}{r.supplierRef && ` · ref ${r.supplierRef}`}{r.note && ` · ${r.note}`}</p>
          <table className="table">
            <thead><tr><th>#</th><th>Line</th><th className="text-right">Accepted</th><th className="text-right">Damaged</th><th className="text-right">Expired</th><th className="text-right">Excess blocked</th><th className="text-right">Missing</th><th /></tr></thead>
            <tbody>
              {r.lines.map((l) => (
                <tr key={l.id}>
                  <td>{l.lineNo}</td>
                  <td>{l.wrongProduct ? `wrong product ×${n(l.baseQty)}${l.held ? " (held)" : " (refused)"}` : `PO line ${po.lines.find((p) => p.id === l.poLineId)?.lineNo}`}{l.inspection && " · inspection"}</td>
                  <td className="text-right tabular-nums">{n(l.qtyAccepted)}</td>
                  <td className="text-right tabular-nums">{n(l.qtyDamaged)}</td>
                  <td className="text-right tabular-nums">{n(l.qtyExpired)}</td>
                  <td className="text-right tabular-nums">{n(l.qtyExcessBlocked)}{l.excessStatus && ` · ${l.excessStatus}`}</td>
                  <td className="text-right tabular-nums">{n(l.qtyMissing)}</td>
                  <td>
                    {l.excessStatus === "pending" && can("purchases.approve") && (
                      <ActionForm action={excessAction.bind(null, l.id)} submit="Decide" className="flex items-center gap-1">
                        <select name="decision" aria-label="Decision" className="input"><option value="approve">Accept into stock</option><option value="reject">Reject (return/dispose)</option></select>
                        <input name="comment" placeholder="Comment" aria-label="Comment" className="input w-32" />
                      </ActionForm>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!r.reversalOfReceiptId && !reversed.has(r.id) && can("inventory.adjust_approve") && (
            <ActionForm action={reverseReceiptAction.bind(null, r.id)} submit="Reverse receipt" className="flex items-end gap-2">
              <label className="label">Reason<input name="reason" required className="input" /></label>
            </ActionForm>
          )}
        </section>
      ))}
    </div>
  );
}
