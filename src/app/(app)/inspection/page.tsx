import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/app/ui/action-form";
import { Denied } from "@/app/ui/denied";
import { pageData } from "@/server/auth/page-ctx";
import { inScope } from "@/server/core/ctx";
import { listEvidence } from "@/server/evidence/evidence";
import { listInspections, listQuarantine } from "@/server/inventory/inspection";
import { inspectAction } from "./actions";

export const metadata: Metadata = { title: "Inspection" };

const REASONS: Record<string, string> = {
  sale_return: "Customer returns", inspection: "Inspection on receipt", excess: "Over-deliveries", wrong_product: "Wrong product",
  supplier_rejected: "Refused by supplier", legacy: "Blocked before Part 7",
};
const label = (s: string) => REASONS[s] ?? s.replaceAll("_", " ");
const n = (d: { toString(): string }) => Number(d.toString()).toLocaleString(undefined, { maximumFractionDigits: 4 });
const at = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ");

// Doc 25 Inspection: quarantine list by reason; inspect form (disposition + evidence) with
// the exact movements each decision posts.
export default async function InspectionPage({ searchParams }: PageProps<"/inspection">) {
  const sp = await searchParams;
  const reason = typeof sp.reason === "string" && sp.reason ? sp.reason : undefined;
  const res = await pageData(async (ctx) => {
    const [lots, recent] = await Promise.all([listQuarantine(ctx, { reason }), listInspections(ctx, { take: 30 })]);
    const evidence = await listEvidence(ctx, "inspection", recent.map((i) => i.id));
    return { lots, recent, evidence };
  });
  if ("denied" in res) return <Denied message={res.denied} />;
  const { lots, recent, evidence } = res.data;
  const ctx = res.ctx;
  const groups = Map.groupBy(lots, (l) => l.reason);

  return (
    <div className="flex max-w-6xl flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="h1">Inspection</h1>
        <form className="flex items-end gap-2">
          <label className="label">Reason
            <select name="reason" defaultValue={reason ?? ""} className="input">
              <option value="">All</option>
              {Object.keys(REASONS).map((r) => <option key={r} value={r}>{label(r)}</option>)}
            </select>
          </label>
          <button className="btn">Filter</button>
        </form>
      </div>
      <details className="card text-sm">
        <summary className="cursor-pointer font-semibold">What each decision posts</summary>
        <ul className="mt-2 list-disc pl-5">
          <li><strong>restockable</strong> → <code>sale_return_restock</code> (customer returns) or <code>blocked_release</code>: blocked −q, on hand +q in the lot&apos;s bin; out of a quarantine bin also <code>putaway_out</code>/<code>putaway_in</code> to the default sellable bin (or the bin you name).</li>
          <li><strong>damaged / defective / missing parts</strong> → <code>blocked_reject</code>: blocked −q, damaged +q.</li>
          <li><strong>expired</strong> → <code>blocked_reject</code>: blocked −q, expired +q.</li>
          <li><strong>dispose</strong> → <code>disposal</code>: blocked −q, written off at current WAC.</li>
        </ul>
        <p className="mt-2 text-muted">A pass is never decided by the person who received the units while another inspector covers the warehouse. Photos/PDFs: JPEG, PNG, WebP or PDF, ≤ 10 MB each.</p>
      </details>

      {lots.length === 0 && <p className="text-muted">Nothing in quarantine.</p>}
      {[...groups].map(([r, ls]) => (
        <section key={r} className="flex flex-col gap-3">
          <h2 className="font-semibold">{label(r)} <span className="text-muted">({ls.length})</span></h2>
          {ls.map((l) => {
            const canInspect = inScope(ctx, l.warehouseId) && (ctx.permissions.has("inventory.inspect") || (r === "sale_return" && ctx.permissions.has("sales.return_inspect")));
            return (
              <div key={l.id} className="card flex flex-col gap-3">
                <p className="text-sm">
                  <span className="font-mono text-xs">{l.variant.sku}</span> {l.variant.product.name} · {l.warehouse.code}/{l.bin.code}
                  {l.batch && ` · batch ${l.batch.batchNo}${l.batch.expiryDate ? ` (exp ${l.batch.expiryDate.toISOString().slice(0, 10)})` : ""}`}
                  {" "}· <strong>{n(l.qtyOpen)}</strong> open of {n(l.qty)} · since {at(l.createdAt)}
                  {l.salesReturnLine && <> · <Link href={`/returns/sales/${l.salesReturnLine.salesReturn.id}`} className="link">{l.salesReturnLine.salesReturn.number}</Link></>}
                  {l.serials.length > 0 && ` · units ${l.serials.join(", ")}`}
                </p>
                {l.passBlocker && <p className="text-sm text-amber-600">{l.passBlocker}</p>}
                {canInspect && (
                  <ActionForm action={inspectAction.bind(null, l.id, l.warehouseId, crypto.randomUUID())} submit="Record decision" className="flex flex-wrap items-end gap-2">
                    <label className="label">Disposition
                      <select name="disposition" className="input">
                        {!l.passBlocker && <option value="restockable">restockable (pass)</option>}
                        <option value="damaged">damaged</option><option value="defective">defective</option><option value="missing_parts">missing parts</option>
                        <option value="expired">expired</option><option value="dispose">dispose</option>
                      </select>
                    </label>
                    <label className="label">Qty<input name="qty" defaultValue={l.qtyOpen.toString()} inputMode="decimal" className="input w-20" /></label>
                    {l.variant.product.isSerialized && <label className="label">Serials<input name="serials" className="input w-40" /></label>}
                    <label className="label">Restock bin<input name="bin" placeholder="default" className="input w-24" /></label>
                    <label className="label">Note<input name="note" className="input" /></label>
                    <label className="label">Evidence<input type="file" name="evidence" multiple accept="image/jpeg,image/png,image/webp,application/pdf" className="input" /></label>
                  </ActionForm>
                )}
              </div>
            );
          })}
        </section>
      ))}

      {recent.length > 0 && (
        <section className="card overflow-x-auto p-0">
          <table className="table">
            <thead><tr><th>When</th><th>Item</th><th>Reason</th><th>Decision</th><th className="text-right">Qty</th><th>Inspector</th><th>Note / evidence</th></tr></thead>
            <tbody>
              {recent.map((i) => (
                <tr key={i.id}>
                  <td>{at(i.createdAt)}</td><td className="font-mono text-xs">{i.lot.variant.sku} @ {i.lot.warehouse.code}</td><td>{label(i.lot.reason)}</td>
                  <td>{i.disposition.replaceAll("_", " ")}</td><td className="text-right tabular-nums">{n(i.qty)}</td>
                  <td>{i.inspector.name}{i.sodWaived && " (single inspector)"}</td>
                  <td className="text-xs">
                    {i.note}
                    {evidence.filter((e) => e.entityId === i.id).map((e) => <a key={e.id} href={`/api/evidence/${e.id}`} className="link ml-2">{e.fileName}</a>)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
