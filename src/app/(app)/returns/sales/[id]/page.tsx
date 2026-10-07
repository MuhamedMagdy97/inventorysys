import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/app/ui/action-form";
import { Denied } from "@/app/ui/denied";
import { pageData } from "@/server/auth/page-ctx";
import { inScope } from "@/server/core/ctx";
import { getSalesReturn } from "@/server/returns/sales-returns";
import { srMoveAction, srReceiveAction, srRejectAction } from "../../actions";

export const metadata: Metadata = { title: "Customer return" };

const n = (d: { toString(): string }) => Number(d.toString()).toLocaleString(undefined, { maximumFractionDigits: 4 });
const label = (s: string) => s.replaceAll("_", " ");
const at = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ");

export default async function SalesReturnPage({ params }: PageProps<"/returns/sales/[id]">) {
  const { id } = await params;
  const res = await pageData((ctx) => getSalesReturn(ctx, id));
  if ("denied" in res) return <Denied message={res.denied} />;
  const r = res.data;
  const ctx = res.ctx;
  const has = (p: string) => ctx.permissions.has(p);
  const mine = r.createdBy === ctx.userId;
  const key = crypto.randomUUID();
  const version = <input type="hidden" name="version" value={r.version} />;
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="flex max-w-6xl flex-col gap-6">
      <div>
        <Link href="/returns" className="link text-sm">← Returns</Link>
        <h1 className="h1 mt-1">{r.number}</h1>
        <p className="text-sm text-muted">
          {label(r.status)} · {r.warehouse.code} · reason {r.reasonCode} · by {r.creator.name} · value at fulfilment cost {r.value.toFixed(2)}{r.note && ` · ${r.note}`}
        </p>
        {r.status === "received" && <p className="text-sm">Waiting for inspection — <Link href="/inspection?reason=sale_return" className="link">open the quarantine list</Link>.</p>}
      </div>

      <section className="flex flex-wrap items-end gap-3">
        {r.status === "requested" && !mine && has("sales.return_approve") && (
          <>
            <ActionForm action={srMoveAction.bind(null, r.id, "approve")} submit="Approve" className="flex items-end gap-2">
              {version}<label className="label">Comment<input name="comment" className="input" /></label>
            </ActionForm>
            <ActionForm action={srRejectAction.bind(null, r.id)} submit="Reject" className="flex items-end gap-2">
              {version}<label className="label">Why<input name="comment" required className="input" /></label>
            </ActionForm>
          </>
        )}
        {["requested", "approved"].includes(r.status) && (has("sales.return_create") || has("sales.return_approve")) && (
          <ActionForm action={srMoveAction.bind(null, r.id, "cancel")} submit="Cancel" className="flex gap-2">{version}</ActionForm>
        )}
      </section>

      {r.status === "approved" && has("sales.return_receive") && inScope(ctx, r.warehouseId) ? (
        <section className="card">
          <h2 className="mb-2 font-semibold">Receive into quarantine</h2>
          <ActionForm action={srReceiveAction.bind(null, r.id, key)} submit="Receive">
            {version}
            <table className="table">
              <thead><tr><th>#</th><th>SKU</th><th>Batch</th><th className="text-right">Expected</th><th>Received</th><th>New expiry (if batch expired)</th></tr></thead>
              <tbody>
                {r.lines.map((l) => (
                  <tr key={l.id}>
                    <td>{l.lineNo}</td><td className="font-mono text-xs">{l.variant.sku}</td>
                    <td>{l.batch ? `${l.batch.batchNo}${l.batch.expiryDate && l.batch.expiryDate.toISOString().slice(0, 10) <= today ? " (expired)" : ""}` : "—"}</td>
                    <td className="text-right tabular-nums">{n(l.qty)}</td>
                    <td><input name={`received.${l.id}`} defaultValue={l.qty.toString()} inputMode="decimal" aria-label={`Received line ${l.lineNo}`} className="input w-20" /></td>
                    <td><input type="date" name={`expiry.${l.id}`} min={today} aria-label={`Expiry line ${l.lineNo}`} className="input" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ActionForm>
        </section>
      ) : (
        <section className="card overflow-x-auto p-0">
          <table className="table">
            <thead><tr><th>#</th><th>SKU</th><th>Batch</th><th className="text-right">Qty</th><th className="text-right">Received</th><th className="text-right">Restocked</th><th className="text-right">Rejected</th><th className="text-right">Disposed</th><th className="text-right">Unit cost</th><th>Serials</th></tr></thead>
            <tbody>
              {r.lines.map((l) => (
                <tr key={l.id}>
                  <td>{l.lineNo}</td>
                  <td><span className="font-mono text-xs">{l.variant.sku}</span> <span className="text-muted">{l.variant.product.name}</span></td>
                  <td>{l.batch?.batchNo ?? "—"}</td>
                  {[l.qty, l.qtyReceived, l.qtyRestocked, l.qtyRejected, l.qtyDisposed, l.unitCost].map((q, i) => <td key={i} className="text-right tabular-nums">{n(q)}</td>)}
                  <td className="text-xs">{l.serials.join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {r.lines.some((l) => l.lot?.inspections.length) && (
        <section className="card">
          <h2 className="mb-2 font-semibold">Inspections</h2>
          <ul className="text-sm">
            {r.lines.flatMap((l) => l.lot?.inspections.map((i) => (
              <li key={i.id}>{at(i.createdAt)} · line {l.lineNo} · {i.inspector.name} · <strong>{label(i.disposition)}</strong> ×{n(i.qty)}{i.sodWaived && " (single inspector)"}{i.note && ` — ${i.note}`}</li>
            )) ?? [])}
          </ul>
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
            <thead><tr><th>When</th><th>Type</th><th>Bin</th><th className="text-right">Blocked Δ</th><th className="text-right">On hand Δ</th><th className="text-right">Value</th></tr></thead>
            <tbody>
              {r.movements.map((m) => (
                <tr key={m.id}>
                  <td>{at(m.createdAt)}</td><td>{m.type}</td><td>{m.bin?.code}</td>
                  <td className="text-right tabular-nums">{n(m.dBlocked)}</td><td className="text-right tabular-nums">{n(m.dOnHand)}</td>
                  <td className="text-right tabular-nums">{m.valueDelta.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
