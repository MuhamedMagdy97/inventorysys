import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/app/ui/action-form";
import { Denied } from "@/app/ui/denied";
import { pageData } from "@/server/auth/page-ctx";
import { inScope } from "@/server/core/ctx";
import { getAdjustment, GRANTS } from "@/server/inventory/adjustments";
import { adjMoveAction, rejectAdjustmentAction } from "../actions";

export const metadata: Metadata = { title: "Adjustment" };

const n = (d: { toString(): string }) => Number(d.toString()).toLocaleString(undefined, { maximumFractionDigits: 4 });
const at = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ");

export default async function AdjustmentPage({ params }: PageProps<"/adjustments/[id]">) {
  const { id } = await params;
  const res = await pageData((ctx) => getAdjustment(ctx, id));
  if ("denied" in res) return <Denied message={res.denied} />;
  const a = res.data;
  const ctx = res.ctx;
  const can = (p: string) => ctx.permissions.has(p) && inScope(ctx, a.warehouseId);
  const g = GRANTS[a.kind];
  const mine = a.createdBy === ctx.userId;
  const key = crypto.randomUUID();
  const version = <input type="hidden" name="version" value={a.version} />;

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <div>
        <Link href="/adjustments" className="link text-sm">← Adjustments</Link>
        <h1 className="h1 mt-1">{a.number}</h1>
        <p className="text-sm text-muted">
          {a.kind} · {a.status} · {a.warehouse.code} · reason {a.reasonCode} · created by {a.creator.name} · value ≈ {a.value.toFixed(2)}
          {a.note && ` · ${a.note}`}
        </p>
      </div>

      <section className="flex flex-wrap gap-3">
        {a.status === "draft" && can(g.submit) && (
          <ActionForm action={adjMoveAction.bind(null, a.id, "submit", undefined)} submit="Submit for approval" className="flex gap-2">{version}</ActionForm>
        )}
        {a.status === "submitted" && !mine && can(g.approve) && (
          <>
            <ActionForm action={adjMoveAction.bind(null, a.id, "approve", key)} submit={a.kind === "adjustment" ? "Approve" : "Approve & apply"} className="flex items-end gap-2">
              {version}<label className="label">Comment<input name="comment" className="input" /></label>
            </ActionForm>
            <ActionForm action={rejectAdjustmentAction.bind(null, a.id)} submit="Reject to draft" className="flex items-end gap-2">
              {version}<label className="label">Why<input name="comment" required className="input" /></label>
            </ActionForm>
          </>
        )}
        {a.status === "approved" && a.kind === "adjustment" && can("inventory.adjust_apply") && (
          <ActionForm action={adjMoveAction.bind(null, a.id, "apply", key)} submit="Apply to stock" className="flex gap-2">{version}</ActionForm>
        )}
        {["draft", "submitted", "approved"].includes(a.status) && (can(g.create) || can(g.approve)) && (
          <ActionForm action={adjMoveAction.bind(null, a.id, "cancel", undefined)} submit="Cancel" className="flex gap-2">{version}</ActionForm>
        )}
      </section>

      <section className="card overflow-x-auto p-0">
        <table className="table">
          <thead><tr><th>#</th><th>SKU</th><th>Batch</th><th>Bin</th><th className="text-right">Qty</th><th>Bucket</th><th className="text-right">Unit cost</th><th>Serials</th></tr></thead>
          <tbody>
            {a.lines.map((l) => (
              <tr key={l.id}>
                <td>{l.lineNo}</td>
                <td><span className="font-mono text-xs">{l.variant.sku}</span> <span className="text-muted">{l.variant.product.name}</span></td>
                <td>{l.batch?.batchNo ?? "—"}</td>
                <td>{l.bin?.code ?? "auto"}</td>
                <td className="text-right tabular-nums">{n(l.qty)}</td>
                <td>{l.bucket ?? "—"}</td>
                <td className="text-right tabular-nums">{l.unitCost ? n(l.unitCost) : "—"}</td>
                <td className="text-xs">{l.serials.join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {a.approvals.length > 0 && (
        <section className="card">
          <h2 className="mb-2 font-semibold">Approvals</h2>
          <ul className="text-sm">
            {a.approvals.map((x) => (
              <li key={x.id}>{at(x.createdAt)} · {x.actor.name} · <strong>{x.decision}</strong>{x.amount && ` ${x.amount.toFixed(2)}`}{x.comment && ` — ${x.comment}`}</li>
            ))}
          </ul>
        </section>
      )}

      {a.movements.length > 0 && (
        <section className="card overflow-x-auto p-0">
          <table className="table">
            <thead><tr><th>When</th><th>Type</th><th>Bin</th><th className="text-right">On hand Δ</th><th className="text-right">Damaged Δ</th><th className="text-right">Value</th></tr></thead>
            <tbody>
              {a.movements.map((m) => (
                <tr key={m.id}>
                  <td>{at(m.createdAt)}</td><td>{m.type}</td><td>{m.bin?.code}</td>
                  <td className="text-right tabular-nums">{n(m.dOnHand)}</td>
                  <td className="text-right tabular-nums">{n(m.dDamaged)}</td>
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
