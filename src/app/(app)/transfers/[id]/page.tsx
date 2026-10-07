import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/app/ui/action-form";
import { Denied } from "@/app/ui/denied";
import { pageData } from "@/server/auth/page-ctx";
import { inScope } from "@/server/core/ctx";
import { db } from "@/server/db";
import { getTransfer } from "@/server/inventory/transfers";
import { receiveTransferAction, rejectTransferAction, shipAction, transferMoveAction, varianceAction } from "../actions";

export const metadata: Metadata = { title: "Transfer" };

const n = (d: { toString(): string }) => Number(d.toString()).toLocaleString(undefined, { maximumFractionDigits: 4 });
const label = (s: string) => s.replaceAll("_", " ");
const at = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ");

export default async function TransferPage({ params }: PageProps<"/transfers/[id]">) {
  const { id } = await params;
  const res = await pageData(async (ctx) => {
    const t = await getTransfer(ctx, id);
    const bins = await db.bin.findMany({
      where: { warehouseId: t.toWarehouseId, archived: false, type: { in: ["receiving", "sellable"] } },
      orderBy: [{ isDefaultReceiving: "desc" }, { code: "asc" }], select: { id: true, code: true },
    });
    return { t, bins };
  });
  if ("denied" in res) return <Denied message={res.denied} />;
  const { t, bins } = res.data;
  const ctx = res.ctx;
  const can = (p: string, wh: string) => ctx.permissions.has(p) && inScope(ctx, wh);
  const either = (p: string) => can(p, t.fromWarehouseId) || can(p, t.toWarehouseId);
  const mine = t.createdBy === ctx.userId;
  const key = crypto.randomUUID(); // rendered into stock-posting forms: a double submit replays
  const version = <input type="hidden" name="version" value={t.version} />;
  const receivable = ["in_transit", "partially_received"].includes(t.status);
  const reported = t.lines.some((l) => Number(l.qtyMissingReported) > 0);

  return (
    <div className="flex max-w-6xl flex-col gap-6">
      <div>
        <Link href="/transfers" className="link text-sm">← Transfers</Link>
        <h1 className="h1 mt-1">{t.number}</h1>
        <p className="text-sm text-muted">
          {label(t.status)} · {t.fromWarehouse.code} → {t.toWarehouse.code} · created by {t.creator.name}
          {t.shippedAt && ` · shipped ${at(t.shippedAt)}`}{t.notes && ` · ${t.notes}`}
        </p>
        {t.reason && <p className="text-sm">Reason: {t.reason}</p>}
      </div>

      <section className="flex flex-wrap gap-3">
        {t.status === "draft" && either("inventory.transfer_submit") && (
          <ActionForm action={transferMoveAction.bind(null, t.id, "submit")} submit="Submit for approval" className="flex gap-2">{version}</ActionForm>
        )}
        {t.status === "submitted" && !mine && can("inventory.transfer_approve", t.fromWarehouseId) && (
          <>
            <ActionForm action={transferMoveAction.bind(null, t.id, "approve")} submit="Approve" className="flex items-end gap-2">
              {version}<label className="label">Comment<input name="comment" className="input" /></label>
            </ActionForm>
            <ActionForm action={rejectTransferAction.bind(null, t.id)} submit="Reject to draft" className="flex items-end gap-2">
              {version}<label className="label">Why<input name="comment" required className="input" /></label>
            </ActionForm>
          </>
        )}
        {["draft", "submitted", "approved"].includes(t.status) && (either("inventory.transfer_create") || either("inventory.transfer_approve")) && (
          <ActionForm action={transferMoveAction.bind(null, t.id, "cancel")} submit="Cancel transfer" className="flex items-end gap-2">
            {version}<label className="label">Reason<input name="reason" className="input" /></label>
          </ActionForm>
        )}
      </section>

      <section className="card overflow-x-auto p-0">
        <table className="table">
          <thead>
            <tr><th>#</th><th>SKU</th><th>Batch</th><th className="text-right">Requested</th><th className="text-right">Shipped</th><th className="text-right">Received</th><th className="text-right">Damaged</th><th className="text-right">Missing</th><th className="text-right">In transit</th></tr>
          </thead>
          <tbody>
            {t.lines.map((l) => (
              <tr key={l.id}>
                <td>{l.lineNo}</td>
                <td><span className="font-mono text-xs">{l.variant.sku}</span> <span className="text-muted">{l.variant.product.name}</span></td>
                <td>{l.batch?.batchNo ?? "—"}</td>
                <td className="text-right tabular-nums">{n(l.qtyRequested)}</td>
                <td className="text-right tabular-nums">{n(l.qtyShipped)}</td>
                <td className="text-right tabular-nums">{n(l.qtyReceived)}</td>
                <td className="text-right tabular-nums">{n(l.qtyDamaged)}</td>
                <td className="text-right tabular-nums">{n(l.qtyMissing)}{Number(l.qtyMissingReported) > 0 && <span className="text-amber-600"> (+{n(l.qtyMissingReported)} reported)</span>}</td>
                <td className="text-right tabular-nums">{n(l.inTransit)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {t.status === "approved" && can("inventory.transfer_ship", t.fromWarehouseId) && (
        <section className="card">
          <h2 className="mb-3 font-semibold">Ship</h2>
          <ActionForm action={shipAction.bind(null, t.id, key)} submit="Confirm shipment">
            {version}
            <table className="table">
              <thead><tr><th>SKU</th><th>Qty to ship</th><th>Serials (serialized items)</th></tr></thead>
              <tbody>
                {t.lines.map((l, i) => (
                  <tr key={l.id}>
                    <td className="font-mono text-xs"><input type="hidden" name={`ship.${i}.lineId`} value={l.id} />{l.variant.sku}</td>
                    <td><input name={`ship.${i}.qty`} defaultValue={l.qtyRequested.toString()} inputMode="decimal" aria-label={`Ship quantity for ${l.variant.sku}`} className="input w-24" /></td>
                    <td>{l.variant.product.isSerialized && <input name={`ship.${i}.serials`} placeholder="S1, S2 …" aria-label={`Serials for ${l.variant.sku}`} className="input w-64" />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-xs text-muted">Units leave the source now; reserved units can&apos;t ship. A line shipped short is not sent later.</p>
          </ActionForm>
        </section>
      )}

      {receivable && can("inventory.transfer_receive", t.toWarehouseId) && (
        <section className="card">
          <h2 className="mb-3 font-semibold">Receive at {t.toWarehouse.code}</h2>
          <ActionForm action={receiveTransferAction.bind(null, t.id, key)} submit="Post receipt">
            {version}
            <div className="overflow-x-auto">
              <table className="table">
                <thead><tr><th>SKU</th><th>In transit</th><th>Received</th><th>Damaged</th><th>Missing</th><th>Bin</th><th>Serials (good / damaged)</th></tr></thead>
                <tbody>
                  {t.lines.map((l, i) => {
                    const open = Number(l.inTransit) - Number(l.qtyMissingReported);
                    const p = `rcv.${i}.`;
                    return (
                      <tr key={l.id}>
                        <td className="font-mono text-xs"><input type="hidden" name={p + "lineId"} value={l.id} />{l.variant.sku}</td>
                        <td className="tabular-nums">{open}</td>
                        <td><input name={p + "received"} defaultValue={open || ""} inputMode="decimal" aria-label={`Received ${l.variant.sku}`} className="input w-20" /></td>
                        <td><input name={p + "damaged"} inputMode="decimal" aria-label={`Damaged ${l.variant.sku}`} className="input w-20" /></td>
                        <td><input name={p + "missing"} inputMode="decimal" aria-label={`Missing ${l.variant.sku}`} className="input w-20" /></td>
                        <td>
                          <select name={p + "binId"} aria-label={`Bin for ${l.variant.sku}`} className="input">{bins.map((b) => <option key={b.id} value={b.id}>{b.code}</option>)}</select>
                        </td>
                        <td>
                          {l.variant.product.isSerialized && (
                            <div className="flex gap-1">
                              <input name={p + "serials"} placeholder="good" aria-label={`Good serials ${l.variant.sku}`} className="input w-32" />
                              <input name={p + "damagedSerials"} placeholder="damaged" aria-label={`Damaged serials ${l.variant.sku}`} className="input w-32" />
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <label className="label">Claim note (damage / shortage)<input name="note" className="input" /></label>
            <p className="text-xs text-muted">Damaged units go to the damaged bin. Missing units stay in transit until an approver confirms the loss.</p>
          </ActionForm>
        </section>
      )}

      {reported && !mine && can("inventory.transfer_approve", t.toWarehouseId) && (
        <section className="card border-amber-500">
          <h2 className="mb-2 font-semibold">Missing units reported</h2>
          <ActionForm action={varianceAction.bind(null, t.id, key)} submit="Decide" className="flex flex-wrap items-end gap-2">
            {version}
            <select name="decision" aria-label="Decision" className="input"><option value="approve">Approve as in-transit loss</option><option value="reject">Reject (still in transit)</option></select>
            <label className="label">Comment (required to reject)<input name="comment" className="input" /></label>
          </ActionForm>
        </section>
      )}

      {t.approvals.length > 0 && (
        <section className="card">
          <h2 className="mb-2 font-semibold">Approvals</h2>
          <ul className="text-sm">
            {t.approvals.map((a) => (
              <li key={a.id}>{at(a.createdAt)} · {a.actor.name} · <strong>{a.decision}</strong> {a.entityType === "transfer_variance" ? "missing units" : "transfer"}{a.amount && ` ${a.amount.toFixed(2)}`}{a.comment && ` — ${a.comment}`}</li>
            ))}
          </ul>
        </section>
      )}

      {t.movements.length > 0 && (
        <section className="card overflow-x-auto p-0">
          <table className="table">
            <thead><tr><th>When</th><th>Type</th><th>Warehouse / bin</th><th className="text-right">Qty</th><th className="text-right">Unit cost</th><th className="text-right">Value</th></tr></thead>
            <tbody>
              {t.movements.map((m) => (
                <tr key={m.id}>
                  <td>{at(m.createdAt)}</td>
                  <td>{label(m.type)}</td>
                  <td>{m.warehouse.code}{m.bin && ` / ${m.bin.code}`}</td>
                  <td className="text-right tabular-nums">{n(Number(m.dOnHand) + Number(m.dDamaged))}</td>
                  <td className="text-right tabular-nums">{m.unitCost ? n(m.unitCost) : "—"}</td>
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
