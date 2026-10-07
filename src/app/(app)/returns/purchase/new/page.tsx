import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/app/ui/action-form";
import { Denied } from "@/app/ui/denied";
import { pageData } from "@/server/auth/page-ctx";
import { requirePermission } from "@/server/core/ctx";
import { db } from "@/server/db";
import { receiptLots } from "@/server/returns/purchase-returns";
import { createPurchaseReturnAction } from "../../actions";

export const metadata: Metadata = { title: "New supplier return" };

// Flow 8: pick the PO, see what each receipt lot can still return (PR-02), list the lines.
export default async function NewPurchaseReturnPage({ searchParams }: PageProps<"/returns/purchase/new">) {
  const sp = await searchParams;
  const poId = typeof sp.poId === "string" ? sp.poId : undefined;
  const res = await pageData(async (ctx) => {
    await requirePermission(ctx, "purchases.return_create");
    const pos = await db.purchaseOrder.findMany({
      where: { companyId: ctx.companyId, receipts: { some: {} } }, orderBy: { createdAt: "desc" }, take: 200,
      select: { id: true, number: true, supplierName: true },
    });
    const lots = poId ? (await receiptLots(db, ctx, { poId })).filter((l) => l.returnable.gt(0)) : [];
    return { pos, lots };
  });
  if ("denied" in res) return <Denied message={res.denied} />;
  const { pos, lots } = res.data;
  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <div>
        <Link href="/returns" className="link text-sm">← Returns</Link>
        <h1 className="h1 mt-1">New supplier return</h1>
      </div>
      <form className="flex items-end gap-3">
        <label className="label">Purchase order
          <select name="poId" defaultValue={poId ?? ""} className="input">
            <option value="">Choose…</option>
            {pos.map((p) => <option key={p.id} value={p.id}>{p.number} · {p.supplierName}</option>)}
          </select>
        </label>
        <button className="btn">Show returnable</button>
      </form>
      {poId && (
        <>
          <section className="card overflow-x-auto p-0">
            <table className="table">
              <thead><tr><th>Receipt</th><th>SKU</th><th>Batch</th><th className="text-right">Unit cost</th><th className="text-right">Returnable</th></tr></thead>
              <tbody>
                {lots.length === 0 && <tr><td colSpan={5} className="text-muted">Nothing left to return on this PO.</td></tr>}
                {lots.map((l) => (
                  <tr key={l.id}>
                    <td className="font-mono text-xs">{l.receipt.number}</td><td className="font-mono text-xs">{l.variant.sku}</td><td>{l.batch?.batchNo ?? "—"}</td>
                    <td className="text-right tabular-nums">{l.unitCost.toFixed(4)}</td><td className="text-right tabular-nums">{l.returnable.toString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section className="card">
            <ActionForm action={createPurchaseReturnAction} submit="Create draft">
              <input type="hidden" name="poId" value={poId} />
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="label">Reason code<input name="reasonCode" required maxLength={50} placeholder="defective, excess, wrong_item…" className="input" /></label>
                <label className="label">Note<input name="note" className="input" /></label>
              </div>
              <div className="overflow-x-auto">
                <table className="table">
                  <thead><tr><th>SKU / barcode</th><th>Qty (base)</th><th>Batch no.</th><th>From bucket</th><th>Serials</th></tr></thead>
                  <tbody>
                    {Array.from({ length: 5 }, (_, i) => {
                      const p = `line.${i}.`;
                      return (
                        <tr key={i}>
                          <td><input name={p + "sku"} aria-label={`Line ${i + 1} SKU`} className="input w-36 font-mono" /></td>
                          <td><input name={p + "qty"} inputMode="decimal" aria-label={`Line ${i + 1} quantity`} className="input w-20" /></td>
                          <td><input name={p + "batchNo"} aria-label={`Line ${i + 1} batch`} className="input w-24" /></td>
                          <td>
                            <select name={p + "bucket"} aria-label={`Line ${i + 1} bucket`} className="input">
                              <option value="onHand">sellable</option><option value="blocked">blocked</option><option value="damaged">damaged</option><option value="expired">expired</option>
                            </select>
                          </td>
                          <td><input name={p + "serials"} aria-label={`Line ${i + 1} serials`} className="input w-40" /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-muted">Each line is linked to the oldest receipt that still has units to return; the shipper can re-point a line before shipping.</p>
            </ActionForm>
          </section>
        </>
      )}
    </div>
  );
}
