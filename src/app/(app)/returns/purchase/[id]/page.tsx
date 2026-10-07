import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/app/ui/action-form";
import { Denied } from "@/app/ui/denied";
import { pageData } from "@/server/auth/page-ctx";
import { inScope } from "@/server/core/ctx";
import { db } from "@/server/db";
import { getPurchaseReturn, receiptLots } from "@/server/returns/purchase-returns";
import { prConfirmAction, prMoveAction, prRejectAction, prShipAction, prSupplierRejectAction } from "../../actions";

export const metadata: Metadata = { title: "Supplier return" };

const n = (d: { toString(): string }) => Number(d.toString()).toLocaleString(undefined, { maximumFractionDigits: 4 });
const label = (s: string) => s.replaceAll("_", " ");
const at = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ");

export default async function PurchaseReturnPage({ params }: PageProps<"/returns/purchase/[id]">) {
  const { id } = await params;
  const res = await pageData(async (ctx) => {
    const r = await getPurchaseReturn(ctx, id);
    // Lots the shipper may re-point each line at (edge #35).
    const lots = r.status === "approved"
      ? await Promise.all(r.lines.map((l) => receiptLots(db, ctx, { poId: r.poId, variantId: l.variantId, batchId: l.batchId, excludeReturnId: r.id })))
      : [];
    return { r, lots };
  });
  if ("denied" in res) return <Denied message={res.denied} />;
  const { r, lots } = res.data;
  const ctx = res.ctx;
  const has = (p: string) => ctx.permissions.has(p);
  const canShip = has("purchases.return_ship") && inScope(ctx, r.warehouseId);
  const paper = has("purchases.return_create") || has("purchases.return_ship");
  const mine = r.createdBy === ctx.userId;
  const key = crypto.randomUUID();
  const version = <input type="hidden" name="version" value={r.version} />;

  return (
    <div className="flex max-w-6xl flex-col gap-6">
      <div>
        <Link href="/returns" className="link text-sm">← Returns</Link>
        <h1 className="h1 mt-1">{r.number}</h1>
        <p className="text-sm text-muted">
          {label(r.status)} · to {r.supplier.name} · PO <Link href={`/purchase-orders/${r.po.id}`} className="link">{r.po.number}</Link> · {r.warehouse.code}
          {" "}· reason {r.reasonCode} · by {r.creator.name} · linked value {r.value.toFixed(2)}{r.creditNoteRef && ` · credit note ${r.creditNoteRef}`}
        </p>
        {r.note && <p className="whitespace-pre-line text-sm">{r.note}</p>}
      </div>

      <section className="flex flex-wrap items-end gap-3">
        {r.status === "draft" && has("purchases.return_create") && (
          <ActionForm action={prMoveAction.bind(null, r.id, "submit")} submit="Submit for approval" className="flex gap-2">{version}</ActionForm>
        )}
        {r.status === "submitted" && !mine && has("purchases.return_approve") && (
          <>
            <ActionForm action={prMoveAction.bind(null, r.id, "approve")} submit="Approve" className="flex items-end gap-2">
              {version}<label className="label">Comment<input name="comment" className="input" /></label>
            </ActionForm>
            <ActionForm action={prRejectAction.bind(null, r.id)} submit="Reject to draft" className="flex items-end gap-2">
              {version}<label className="label">Why<input name="comment" required className="input" /></label>
            </ActionForm>
          </>
        )}
        {r.status === "shipped" && paper && (
          <ActionForm action={prConfirmAction.bind(null, r.id)} submit="Supplier confirmed" className="flex items-end gap-2">
            {version}<label className="label">Credit note ref<input name="creditNoteRef" className="input" /></label>
          </ActionForm>
        )}
        {r.status === "shipped" && canShip && (
          <ActionForm action={prSupplierRejectAction.bind(null, r.id, key)} submit="Supplier refused — back to quarantine" className="flex items-end gap-2">
            {version}<label className="label">Why<input name="note" required className="input" /></label>
          </ActionForm>
        )}
        {["supplier_confirmed", "supplier_rejected"].includes(r.status) && paper && (
          <ActionForm action={prMoveAction.bind(null, r.id, "close")} submit="Close" className="flex gap-2">{version}</ActionForm>
        )}
        {["draft", "submitted", "approved"].includes(r.status) && (has("purchases.return_create") || has("purchases.return_approve")) && (
          <ActionForm action={prMoveAction.bind(null, r.id, "cancel")} submit="Cancel" className="flex gap-2">{version}</ActionForm>
        )}
      </section>

      {r.status === "approved" && canShip ? (
        <section className="card">
          <h2 className="mb-2 font-semibold">Ship</h2>
          <ActionForm action={prShipAction.bind(null, r.id, key)} submit="Ship to supplier">
            {version}
            <table className="table">
              <thead><tr><th>#</th><th>SKU</th><th className="text-right">Qty</th><th>From</th><th>Linked receipt lot (cost relieved)</th></tr></thead>
              <tbody>
                {r.lines.map((l, i) => (
                  <tr key={l.id}>
                    <td>{l.lineNo}</td><td className="font-mono text-xs">{l.variant.sku}</td><td className="text-right tabular-nums">{n(l.qty)}</td><td>{l.bucket}</td>
                    <td>
                      {l.serials.length ? <span className="text-xs">{l.receiptLine.receipt.number} (serials {l.serials.join(", ")})</span> : (
                        <select name={`lot.${l.id}`} defaultValue={l.receiptLineId} aria-label={`Lot for line ${l.lineNo}`} className="input">
                          {lots[i].filter((x) => x.returnable.gt(0) || x.id === l.receiptLineId).map((x) => (
                            <option key={x.id} value={x.id}>{x.receipt.number} · {x.unitCost.toFixed(4)} · {x.returnable.toString()} returnable</option>
                          ))}
                        </select>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ActionForm>
        </section>
      ) : (
        <section className="card overflow-x-auto p-0">
          <table className="table">
            <thead><tr><th>#</th><th>SKU</th><th>Batch</th><th>From</th><th className="text-right">Qty</th><th>Linked receipt</th><th className="text-right">Unit cost</th><th>Serials</th></tr></thead>
            <tbody>
              {r.lines.map((l) => (
                <tr key={l.id}>
                  <td>{l.lineNo}</td>
                  <td><span className="font-mono text-xs">{l.variant.sku}</span> <span className="text-muted">{l.variant.product.name}</span></td>
                  <td>{l.batch?.batchNo ?? "—"}</td><td>{l.bucket}</td><td className="text-right tabular-nums">{n(l.qty)}</td>
                  <td className="font-mono text-xs">{l.receiptLine.receipt.number}</td><td className="text-right tabular-nums">{n(l.unitCost)}</td>
                  <td className="text-xs">{l.serials.join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {r.approvals.length > 0 && (
        <section className="card">
          <h2 className="mb-2 font-semibold">Approvals</h2>
          <ul className="text-sm">
            {r.approvals.map((x) => <li key={x.id}>{at(x.createdAt)} · {x.actor.name} · <strong>{x.decision}</strong>{x.amount && ` ${x.amount.toFixed(2)}`}{x.comment && ` — ${x.comment}`}</li>)}
          </ul>
        </section>
      )}

      {r.movements.length > 0 && (
        <section className="card overflow-x-auto p-0">
          <table className="table">
            <thead><tr><th>When</th><th>Type</th><th>Bin</th><th>Receipt</th><th className="text-right">Qty Δ</th><th className="text-right">Unit cost</th><th className="text-right">Value</th></tr></thead>
            <tbody>
              {r.movements.map((m) => (
                <tr key={m.id}>
                  <td>{at(m.createdAt)}</td><td>{m.type}</td><td>{m.bin?.code}</td><td className="font-mono text-xs">{m.linkedReceipt?.number ?? "—"}</td>
                  <td className="text-right tabular-nums">{n(Number(m.dOnHand) + Number(m.dBlocked) + Number(m.dDamaged) + Number(m.dExpired))}</td>
                  <td className="text-right tabular-nums">{m.unitCost ? n(m.unitCost) : "—"}</td><td className="text-right tabular-nums">{m.valueDelta.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
