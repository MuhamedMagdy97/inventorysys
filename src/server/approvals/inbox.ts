import type { AdjustmentKind } from "@/generated/prisma/client";
import { inScope, type Ctx } from "@/server/core/ctx";
import { AppError } from "@/server/core/errors";
import { db, type Tx } from "@/server/db";
import { adjustmentValue, applyAdjustment, approveAdjustment, GRANTS, rejectAdjustment } from "@/server/inventory/adjustments";
import { dec } from "@/server/inventory/post";
import { approveTransfer, decideVariance, rejectTransfer } from "@/server/inventory/transfers";
import { approvePo, rejectPo } from "@/server/purchasing/purchase-orders";
import { decideExcess } from "@/server/purchasing/receipts";
import { readSettings } from "@/server/settings/settings";

// Doc 25 Approvals Inbox: everything waiting on the current user, oldest first, with
// SLA age (N-04). Only items the user may decide: right grant, warehouse in scope, not
// their own document (INV-006). Over-limit items are shown flagged — they need someone
// with a higher limit (INV-020). ponytail: escalation job + reminders arrive with Part 9.

export type InboxItem = {
  type: "purchase_order" | "receipt_excess" | "transfer" | "transfer_variance" | "stock_adjustment" | "adjustment_apply";
  id: string; // the document the decision acts on
  version: number | null;
  number: string;
  summary: string;
  amount: string | null;
  waitingSince: Date;
  ageHours: number;
  overdue: boolean;
  overLimit: boolean;
  link: string;
};

const ago = (d: Date) => Math.floor((Date.now() - d.getTime()) / 3_600_000);

export async function listInbox(ctx: Ctx): Promise<{ slaHours: number; items: InboxItem[] }> {
  const has = (p: string) => ctx.permissions.has(p);
  const limitOk = (grant: string, amount: string | number) => {
    const l = ctx.limits?.get(grant);
    return l == null || dec(l).gte(dec(amount));
  };
  const me = { not: ctx.userId };
  const scoped = <T>(rows: T[], wh: (r: T) => string) => rows.filter((r) => inScope(ctx, wh(r)));
  const out: Omit<InboxItem, "ageHours" | "overdue">[] = [];

  if (has("purchases.approve")) {
    const pos = await db.purchaseOrder.findMany({ where: { companyId: ctx.companyId, status: "submitted", createdBy: me } });
    for (const p of pos) {
      out.push({
        type: "purchase_order", id: p.id, version: p.version, number: p.number, summary: `PO to ${p.supplierName}`,
        amount: `${p.total.toFixed(2)} ${p.currency}`, waitingSince: p.updatedAt, overLimit: !limitOk("purchases.approve", p.total.toString()), link: `/purchase-orders/${p.id}`,
      });
    }
    const excess = await db.receiptLine.findMany({
      where: { excessStatus: "pending", receipt: { companyId: ctx.companyId, po: { createdBy: me } } },
      include: { variant: { select: { sku: true } }, receipt: { include: { po: { select: { id: true, number: true } } } } },
    });
    for (const l of excess) {
      const amount = dec(l.qtyExcessBlocked).times(dec(l.unitCost)).toFixed(2);
      out.push({
        type: "receipt_excess", id: l.id, version: null, number: l.receipt.po.number, summary: `Over-delivery ${l.variant.sku} ×${dec(l.qtyExcessBlocked).toString()} on ${l.receipt.number}`,
        amount, waitingSince: l.receipt.receivedAt, overLimit: !limitOk("purchases.approve", amount), link: `/purchase-orders/${l.receipt.po.id}`,
      });
    }
  }

  if (has("inventory.transfer_approve")) {
    const ts = await db.transfer.findMany({
      where: { companyId: ctx.companyId, status: "submitted", createdBy: me },
      include: { fromWarehouse: { select: { code: true } }, toWarehouse: { select: { code: true } }, lines: true },
    });
    for (const t of scoped(ts, (t) => t.fromWarehouseId)) {
      const costs = await db.variantCost.findMany({ where: { warehouseId: t.fromWarehouseId, variantId: { in: t.lines.map((l) => l.variantId) } } });
      const amount = t.lines.reduce((s, l) => {
        const c = costs.find((x) => x.variantId === l.variantId);
        return c && !dec(c.qty).isZero() ? s.plus(dec(l.qtyRequested).times(dec(c.value)).div(dec(c.qty))) : s;
      }, dec(0)).toFixed(2);
      out.push({
        type: "transfer", id: t.id, version: t.version, number: t.number, summary: `Transfer ${t.fromWarehouse.code} → ${t.toWarehouse.code}, ${t.lines.length} line(s)`,
        amount, waitingSince: t.updatedAt, overLimit: !limitOk("inventory.transfer_approve", amount), link: `/transfers/${t.id}`,
      });
    }
    const variances = await db.transfer.findMany({
      where: { companyId: ctx.companyId, createdBy: me, lines: { some: { qtyMissingReported: { gt: 0 } } } },
      include: { lines: { where: { qtyMissingReported: { gt: 0 } } } },
    });
    for (const t of scoped(variances, (t) => t.toWarehouseId)) {
      const amount = t.lines.reduce((s, l) => s.plus(dec(l.qtyMissingReported).times(dec(l.shippedValue)).div(dec(l.qtyShipped))), dec(0)).toFixed(2);
      out.push({
        type: "transfer_variance", id: t.id, version: t.version, number: t.number,
        summary: `Missing in transit: ${t.lines.reduce((s, l) => s.plus(dec(l.qtyMissingReported)), dec(0)).toString()} unit(s)`,
        amount, waitingSince: t.updatedAt, overLimit: !limitOk("inventory.transfer_approve", amount), link: `/transfers/${t.id}`,
      });
    }
  }

  const kinds = (Object.keys(GRANTS) as AdjustmentKind[]).filter((k) => has(GRANTS[k].approve));
  if (kinds.length) {
    const adjs = await db.stockAdjustment.findMany({
      where: { companyId: ctx.companyId, status: "submitted", kind: { in: kinds }, createdBy: me },
      include: { warehouse: { select: { code: true } }, lines: true },
    });
    for (const a of scoped(adjs, (a) => a.warehouseId)) {
      const amount = (await adjustmentValue(db, a)).toFixed(2);
      out.push({
        type: "stock_adjustment", id: a.id, version: a.version, number: a.number, summary: `${a.kind} at ${a.warehouse.code} (${a.reasonCode}), ${a.lines.length} line(s)`,
        amount, waitingSince: a.updatedAt, overLimit: !limitOk(GRANTS[a.kind].approve, amount), link: `/adjustments/${a.id}`,
      });
    }
  }
  if (has("inventory.adjust_apply")) {
    const ready = await db.stockAdjustment.findMany({
      where: { companyId: ctx.companyId, status: "approved", kind: "adjustment" }, include: { warehouse: { select: { code: true } } },
    });
    for (const a of scoped(ready, (a) => a.warehouseId)) {
      out.push({
        type: "adjustment_apply", id: a.id, version: a.version, number: a.number, summary: `Approved adjustment at ${a.warehouse.code} — apply to stock`,
        amount: null, waitingSince: a.approvedAt ?? a.updatedAt, overLimit: false, link: `/adjustments/${a.id}`,
      });
    }
  }

  const { approvalSlaHours } = await readSettings(db, ctx.companyId);
  const items = out
    .map((i) => ({ ...i, ageHours: ago(i.waitingSince), overdue: ago(i.waitingSince) >= approvalSlaHours }))
    .sort((a, b) => a.waitingSince.getTime() - b.waitingSince.getTime());
  return { slaHours: approvalSlaHours, items };
}

// One decision from the inbox, routed to the document's own transition (which re-checks
// grant, scope, limit, SoD and version — INV-018/023).
export async function decide(
  tx: Tx,
  ctx: Ctx,
  input: { type: InboxItem["type"]; id: string; version: number | null; approve: boolean; comment?: string | null },
) {
  const v = input.version ?? -1;
  const comment = input.comment?.trim() || null;
  switch (input.type) {
    case "purchase_order":
      return input.approve ? approvePo(tx, ctx, { id: input.id, version: v, comment }) : rejectPo(tx, ctx, { id: input.id, version: v, comment: comment ?? "" });
    case "receipt_excess":
      return decideExcess(tx, ctx, { receiptLineId: input.id, approve: input.approve, comment });
    case "transfer":
      return input.approve ? approveTransfer(tx, ctx, { id: input.id, version: v, comment }) : rejectTransfer(tx, ctx, { id: input.id, version: v, comment: comment ?? "" });
    case "transfer_variance":
      return decideVariance(tx, ctx, { id: input.id, version: v, approve: input.approve, comment });
    case "stock_adjustment":
      return input.approve ? approveAdjustment(tx, ctx, { id: input.id, version: v, comment }) : rejectAdjustment(tx, ctx, { id: input.id, version: v, comment: comment ?? "" });
    case "adjustment_apply":
      if (!input.approve) throw new AppError("validation_error", "An approved adjustment is applied or cancelled on its page");
      return applyAdjustment(tx, ctx, { id: input.id, version: v });
  }
}
