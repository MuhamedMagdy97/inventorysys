import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/app/ui/action-form";
import { Denied } from "@/app/ui/denied";
import { pageData } from "@/server/auth/page-ctx";
import { inScope } from "@/server/core/ctx";
import { getCount } from "@/server/inventory/counts";
import { countMoveAction, enterCountsAction, recountAction } from "../actions";

export const metadata: Metadata = { title: "Stock count" };

const n = (d: { toString(): string } | null | undefined) => (d == null ? "—" : Number(d.toString()).toLocaleString(undefined, { maximumFractionDigits: 4 }));
const at = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ");

export default async function CountPage({ params }: PageProps<"/counts/[id]">) {
  const { id } = await params;
  const res = await pageData((ctx) => getCount(ctx, id));
  if ("denied" in res) return <Denied message={res.denied} />;
  const c = res.data;
  const ctx = res.ctx;
  const can = (p: string) => ctx.permissions.has(p) && inScope(ctx, c.warehouseId);
  const counting = c.status === "open" || c.status === "counting";
  const mayApprove = can("inventory.count_approve") && c.createdBy !== ctx.userId && !c.counters.includes(ctx.userId);
  const key = crypto.randomUUID();
  const version = <input type="hidden" name="version" value={c.version} />;

  return (
    <div className="flex max-w-6xl flex-col gap-6">
      <div>
        <Link href="/counts" className="link text-sm">← Counts</Link>
        <h1 className="h1 mt-1">{c.number}</h1>
        <p className="text-sm text-muted">
          {c.status} · {c.warehouse.code} · bin {c.bin?.code ?? "all"} · snapshot {at(c.snapshotAt)} · opened by {c.creator.name} · variance value ≈ {c.value.toFixed(2)} · recount above {c.recountPct}%
          {c.note && ` · ${c.note}`}
        </p>
      </div>

      <section className="flex flex-wrap gap-3">
        {c.status === "counting" && can("inventory.count_submit") && (
          <ActionForm action={countMoveAction.bind(null, c.id, "submit", undefined)} submit="Submit for review" className="flex gap-2">{version}</ActionForm>
        )}
        {c.status === "variance_review" && mayApprove && (
          <ActionForm action={countMoveAction.bind(null, c.id, "approve", undefined)} submit="Approve variances" className="flex items-end gap-2">
            {version}<label className="label">Comment<input name="comment" className="input" /></label>
          </ActionForm>
        )}
        {c.status === "approved" && can("inventory.count_apply") && (
          <ActionForm action={countMoveAction.bind(null, c.id, "apply", key)} submit="Apply to stock" className="flex gap-2">{version}</ActionForm>
        )}
        {["open", "counting", "variance_review", "approved"].includes(c.status) && (can("inventory.count_create") || can("inventory.count_approve")) && (
          <ActionForm action={countMoveAction.bind(null, c.id, "cancel", undefined)} submit="Cancel count" className="flex gap-2">{version}</ActionForm>
        )}
      </section>

      {counting && can("inventory.count_submit") ? (
        <section className="card">
          <h2 className="mb-2 font-semibold">Count entry</h2>
          <p className="mb-2 text-xs text-muted">Fill only what you count now; a saved entry records the system quantity at that moment (placeholders show earlier counts).</p>
          <ActionForm action={enterCountsAction.bind(null, c.id, c.warehouseId)} submit="Save counts">
            <div className="overflow-x-auto">
              <table className="table">
                <thead><tr><th>#</th><th>Bin</th><th>SKU</th><th>Batch</th><th>Counted</th><th>Recount?</th></tr></thead>
                <tbody>
                  {c.lines.map((l) => (
                    <tr key={l.id}>
                      <td>{l.lineNo}</td><td>{l.bin.code}</td>
                      <td><span className="font-mono text-xs">{l.variant.sku}</span> <span className="text-muted">{l.variant.product.name}</span></td>
                      <td>{l.batch?.batchNo ?? "—"}</td>
                      <td>
                        {l.variant.product.isSerialized
                          ? <input name={`serials.${l.id}`} placeholder={l.countedSerials.length ? l.countedSerials.join(" ") : "scan serials"} aria-label={`Line ${l.lineNo} serials`} className="input w-64" />
                          : <input name={`qty.${l.id}`} inputMode="decimal" placeholder={l.countedQty?.toString() ?? ""} aria-label={`Line ${l.lineNo} counted`} className="input w-24" />}
                      </td>
                      <td>{l.recountRequested ? <strong>recount</strong> : l.countedQty != null ? "counted" : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <fieldset className="flex flex-wrap items-end gap-3">
              <legend className="text-sm font-semibold">Found an item not on the sheet</legend>
              <label className="label">Scan SKU / barcode<input name="found.code" className="input w-40 font-mono" /></label>
              <label className="label">Bin code<input name="found.bin" className="input w-24" /></label>
              <label className="label">Batch no.<input name="found.batchNo" className="input w-24" /></label>
              <label className="label">Qty<input name="found.qty" inputMode="decimal" className="input w-20" /></label>
              <label className="label">Serials<input name="found.serials" className="input w-48" /></label>
            </fieldset>
          </ActionForm>
        </section>
      ) : null}

      <section className="card overflow-x-auto p-0">
        <ActionForm action={recountAction.bind(null, c.id)} submit="Recount selected lines" className="flex flex-col gap-3 p-3">
          {version}
          <table className="table">
            <thead>
              <tr>
                <th></th><th>#</th><th>Bin</th><th>SKU</th><th>Batch</th><th className="text-right">Snapshot</th><th className="text-right">System at count</th>
                <th className="text-right">Counted</th><th className="text-right">Variance</th><th className="text-right">Current</th><th className="text-right">After apply</th><th>Counted at</th>
              </tr>
            </thead>
            <tbody>
              {c.lines.map((l) => (
                <tr key={l.id} className={l.large ? "bg-amber-50 dark:bg-amber-950" : undefined}>
                  <td>{c.status === "variance_review" && <input type="checkbox" name="lineId" value={l.id} aria-label={`Recount line ${l.lineNo}`} />}</td>
                  <td>{l.lineNo}</td><td>{l.bin.code}</td>
                  <td className="font-mono text-xs">{l.variant.sku}</td>
                  <td>{l.batch?.batchNo ?? "—"}</td>
                  <td className="text-right tabular-nums">{n(l.snapshotQty)}</td>
                  <td className="text-right tabular-nums">{n(l.systemQty)}</td>
                  <td className="text-right tabular-nums">{n(l.countedQty)}{l.recounts > 0 && ` (recounted)`}</td>
                  <td className="text-right tabular-nums">{n(l.variance)}{l.large && " ⚠"}</td>
                  <td className="text-right tabular-nums">{n(l.qtyAtApply ?? l.current)}</td>
                  <td className="text-right tabular-nums">{n(l.afterApply)}</td>
                  <td>{l.countedAt ? at(l.countedAt) : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {c.status !== "variance_review" && <p className="text-xs text-muted">Lines can be sent back for recount during variance review.</p>}
        </ActionForm>
      </section>

      {c.approvals.length > 0 && (
        <section className="card">
          <h2 className="mb-2 font-semibold">Approvals</h2>
          <ul className="text-sm">
            {c.approvals.map((x) => <li key={x.id}>{at(x.createdAt)} · {x.actor.name} · <strong>{x.decision}</strong>{x.amount && ` ${x.amount.toFixed(2)}`}{x.comment && ` — ${x.comment}`}</li>)}
          </ul>
        </section>
      )}

      {c.movements.length > 0 && (
        <section className="card overflow-x-auto p-0">
          <table className="table">
            <thead><tr><th>When</th><th>Type</th><th>Bin</th><th className="text-right">On hand Δ</th><th className="text-right">Value</th></tr></thead>
            <tbody>
              {c.movements.map((m) => (
                <tr key={m.id}>
                  <td>{at(m.createdAt)}</td><td>{m.type}</td><td>{m.bin?.code}</td>
                  <td className="text-right tabular-nums">{n(m.dOnHand)}</td>
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
