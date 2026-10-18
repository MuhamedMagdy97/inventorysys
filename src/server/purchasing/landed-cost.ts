import type { LandedCostMethod } from "@/generated/prisma/client";
import { writeAudit } from "@/server/core/audit";
import { requireNotCreator, requirePermission, type Ctx } from "@/server/core/ctx";
import { AppError, assertVersion } from "@/server/core/errors";
import { nextNumber } from "@/server/core/sequences";
import { db, type Tx } from "@/server/db";
import { Dec, dec, lockPositions, postMovements, type DecValue } from "@/server/inventory/post";

// Landed-cost allocation (doc 15 §1.1): charges on one receipt, allocated to its lines
// by value (default) or qty; approval (≠ creator, limit on the total) posts one
// cost_correction per line into WAC. Units already gone get the expensed share.

export const CHARGE_KINDS = ["shipping", "duty", "tax", "other"] as const;
export type Charge = { kind: (typeof CHARGE_KINDS)[number]; amount: DecValue };

const s4 = (d: Dec) => d.toFixed(4);
const ZERO = dec(0);

// alloc_i = round(total × basis_i / Σbasis, 4); the last line with basis > 0 takes the residual.
export function allocate(total: DecValue, bases: DecValue[]): Dec[] {
  const t = dec(total), b = bases.map(dec);
  const sum = b.reduce((x, y) => x.plus(y), ZERO);
  if (!sum.gt(0)) throw new AppError("validation_error", "Nothing to allocate on: the basis is 0 (try allocating by qty)", { field: "method" });
  const last = b.findLastIndex((x) => x.gt(0));
  const out = b.map((x) => t.times(x).div(sum).toDecimalPlaces(4));
  out[last] = t.minus(out.reduce((x, y, i) => (i === last ? x : x.plus(y)), ZERO));
  return out;
}

const basisQty = (l: { qtyAccepted: DecValue; qtyDamaged: DecValue; qtyExpired: DecValue; qtyExcessBlocked: DecValue; excessStatus: string | null }) =>
  dec(l.qtyAccepted).plus(dec(l.qtyDamaged)).plus(dec(l.qtyExpired)).plus(l.excessStatus === "approved" ? dec(l.qtyExcessBlocked) : ZERO);

export async function createLandedCost(
  tx: Tx,
  ctx: Ctx,
  input: { receiptId: string; method?: LandedCostMethod; charges: Charge[]; note?: string | null },
) {
  const r = await tx.goodsReceipt.findFirst({
    where: { id: input.receiptId, companyId: ctx.companyId },
    include: { lines: { orderBy: { lineNo: "asc" } }, reversal: { select: { id: true } } },
  });
  if (!r) throw new AppError("not_found", "Receipt not found");
  await requirePermission(ctx, "inventory.adjust_create", { warehouseId: r.warehouseId });
  if (r.reversalOfReceiptId || r.reversal) throw new AppError("invalid_transition", "Landed cost goes on a live receipt, not a reversal or a reversed one", { field: "receiptId" });

  const charges = input.charges.map((c) => {
    const amount = dec(c.amount);
    if (!CHARGE_KINDS.includes(c.kind) || amount.isNeg() || amount.decimalPlaces() > 4) {
      throw new AppError("validation_error", "Each charge: shipping | duty | tax | other, amount ≥ 0 with max 4 decimals", { field: "charges" });
    }
    return { kind: c.kind, amount: s4(amount) };
  }).filter((c) => !dec(c.amount).isZero());
  const total = charges.reduce((t, c) => t.plus(c.amount), ZERO);
  if (!total.gt(0)) throw new AppError("validation_error", "Enter at least one charge > 0", { field: "charges" });

  const method = input.method ?? "value";
  const lines = r.lines.filter((l) => !l.wrongProduct).map((l) => {
    const q = basisQty(l);
    return { l, q, v: q.times(dec(l.unitCost)).toDecimalPlaces(4) };
  });
  const alloc = allocate(total, lines.map((x) => (method === "value" ? x.v : x.q)));
  const year = new Date().getUTCFullYear();
  const lc = await tx.landedCost.create({
    data: {
      companyId: ctx.companyId, number: await nextNumber(tx, ctx.companyId, `lc:${year}`, `LC-${year}-`, 5),
      receiptId: r.id, warehouseId: r.warehouseId, method, charges, total: s4(total), note: input.note?.trim() || null, createdBy: ctx.userId,
      lines: {
        createMany: {
          data: lines.map((x, i) => ({
            receiptLineId: x.l.id, variantId: x.l.variantId, batchId: x.l.batchId, basisQty: s4(x.q), basisValue: s4(x.v), allocated: s4(alloc[i]),
          })),
        },
      },
    },
    include: { lines: true },
  });
  await writeAudit(tx, ctx, { action: "create", entityType: "landed_cost", entityId: lc.id, warehouseId: r.warehouseId, after: lc });
  return lc;
}

async function lockLandedCost(tx: Tx, ctx: Ctx, id: string, version: number) {
  await tx.$executeRaw`SELECT 1 FROM landed_cost WHERE id = ${id} AND company_id = ${ctx.companyId} FOR UPDATE`;
  const lc = await tx.landedCost.findFirst({ where: { id, companyId: ctx.companyId }, include: { lines: true } });
  if (!lc) throw new AppError("not_found", "Landed cost not found");
  if (lc.version !== version) throw new AppError("version_conflict", "Landed cost was changed by someone else", { currentVersion: lc.version });
  if (lc.status !== "submitted") throw new AppError("invalid_transition", `Landed cost is already ${lc.status}`, { status: lc.status });
  return lc;
}

export async function approveLandedCost(tx: Tx, ctx: Ctx, input: { id: string; version: number; comment?: string | null }) {
  const lc = await lockLandedCost(tx, ctx, input.id, input.version);
  await requirePermission(ctx, "inventory.adjust_approve", { warehouseId: lc.warehouseId, amount: lc.total });
  await requireNotCreator(ctx, lc.createdBy, { type: "landed_cost", id: lc.id });

  // Read valued qty under the position + cost locks (same order postMovements takes them).
  await lockPositions(tx, ctx, lc.lines.map((l) => [l.variantId, lc.warehouseId, l.batchId] as const));
  const variants = [...new Set(lc.lines.map((l) => l.variantId))].sort();
  const costs = await tx.$queryRaw<{ variant_id: string; qty: string }[]>`
    SELECT variant_id, qty::text FROM variant_cost
    WHERE company_id = ${ctx.companyId} AND warehouse_id = ${lc.warehouseId} AND variant_id = ANY(${variants}::text[])
    ORDER BY variant_id FOR UPDATE`;
  const ratio = new Map(variants.map((v) => {
    const received = lc.lines.filter((l) => l.variantId === v).reduce((t, l) => t.plus(dec(l.basisQty)), ZERO);
    const left = dec(costs.find((c) => c.variant_id === v)?.qty ?? 0);
    return [v, received.isZero() ? ZERO : Dec.min(left, received).div(received)];
  }));

  const split = lc.lines.map((l) => {
    const cap = dec(l.allocated).times(ratio.get(l.variantId)!).toDecimalPlaces(4);
    return { l, cap, exp: dec(l.allocated).minus(cap) };
  });
  const legs = split.filter((x) => x.cap.gt(0)).map((x) => ({
    type: "cost_correction" as const, variantId: x.l.variantId, warehouseId: lc.warehouseId, batchId: x.l.batchId,
    delta: {}, value: x.cap, line: x.l.id, reasonCode: "landed_cost", note: lc.number,
  }));
  const posted = legs.length ? await postMovements(tx, ctx, { sourceType: "landed_cost", sourceId: lc.id, legs, action: "landed_cost" }) : null;
  for (const x of split) await tx.landedCostLine.update({ where: { id: x.l.id }, data: { capitalized: s4(x.cap), expensed: s4(x.exp) } });

  const capitalized = split.reduce((t, x) => t.plus(x.cap), ZERO);
  assertVersion(await tx.landedCost.updateMany({
    where: { id: lc.id, version: input.version },
    data: { status: "posted", capitalized: s4(capitalized), expensed: s4(dec(lc.total).minus(capitalized)), decidedBy: ctx.userId, decidedAt: new Date(), version: { increment: 1 } },
  }), "Landed cost", lc.version);
  await tx.approval.create({ data: { companyId: ctx.companyId, entityType: "landed_cost", entityId: lc.id, actorId: ctx.userId, decision: "approved", amount: lc.total, comment: input.comment?.trim() || null } });
  const audit = await writeAudit(tx, ctx, {
    action: "approve_post", entityType: "landed_cost", entityId: lc.id, warehouseId: lc.warehouseId,
    before: { status: lc.status, version: lc.version }, after: { status: "posted", capitalized: s4(capitalized), movementIds: posted?.movements.map((m) => m.id) ?? [] },
  });
  return { id: lc.id, status: "posted" as const, capitalized: s4(capitalized), expensed: s4(dec(lc.total).minus(capitalized)), movementIds: posted?.movements.map((m) => m.id) ?? [], auditId: audit.id };
}

export async function rejectLandedCost(tx: Tx, ctx: Ctx, input: { id: string; version: number; comment: string }) {
  const lc = await lockLandedCost(tx, ctx, input.id, input.version);
  await requirePermission(ctx, "inventory.adjust_approve", { warehouseId: lc.warehouseId });
  const comment = input.comment?.trim();
  if (!comment) throw new AppError("validation_error", "Say why it is rejected", { field: "comment" });
  assertVersion(await tx.landedCost.updateMany({
    where: { id: lc.id, version: input.version },
    data: { status: "rejected", decidedBy: ctx.userId, decidedAt: new Date(), version: { increment: 1 } },
  }), "Landed cost", lc.version);
  await tx.approval.create({ data: { companyId: ctx.companyId, entityType: "landed_cost", entityId: lc.id, actorId: ctx.userId, decision: "rejected", amount: lc.total, comment } });
  const audit = await writeAudit(tx, ctx, { action: "reject", entityType: "landed_cost", entityId: lc.id, warehouseId: lc.warehouseId, before: { status: lc.status }, after: { status: "rejected" }, reason: comment });
  return { id: lc.id, status: "rejected" as const, auditId: audit.id };
}

// Landed costs of one PO's receipts (PO detail page) or one receipt.
export async function listLandedCosts(ctx: Ctx, input: { poId?: string; receiptId?: string }) {
  await requirePermission(ctx, ["purchases.view", "inventory.view"]);
  return db.landedCost.findMany({
    where: {
      companyId: ctx.companyId, receiptId: input.receiptId,
      ...(input.poId ? { receipt: { poId: input.poId } } : {}),
      ...(ctx.warehouseIds === "all" ? {} : { warehouseId: { in: ctx.warehouseIds } }),
    },
    include: { lines: { include: { receiptLine: { select: { lineNo: true } } } } },
    orderBy: { createdAt: "asc" },
  });
}
