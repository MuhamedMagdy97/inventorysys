import type { AdjustmentKind, AdjustmentStatus, Prisma, SerialStatus } from "@/generated/prisma/client";
import { assertTransactable } from "@/server/catalog/catalog";
import { writeAudit } from "@/server/core/audit";
import { requireNotCreator, requirePermission, scopeFilter, type Ctx } from "@/server/core/ctx";
import { AppError, assertVersion } from "@/server/core/errors";
import { nextNumber } from "@/server/core/sequences";
import { stateMachine } from "@/server/core/state";
import { db, type Tx } from "@/server/db";
import { notify } from "@/server/notifications/notify";
import { Dec, dec, lockPositions, pickBins, postMovements, type Bucket, type DecValue, type Leg } from "./post";
import { perBin, takeSerials } from "./serials";

// Flow 12 (adjust), 17 (damage), 27 (repair), 28 (dispose); doc 23. One document type
// with a kind: draft → submitted → approved (≠ creator, limit on value) → applied.
// Damage/repair/disposal apply on approval (doc 23 "request → approved → applied");
// adjustments are applied separately by an `adjust_apply` holder. I-07 at apply time.

export const ADJ = stateMachine<AdjustmentStatus>("Adjustment", {
  draft: ["submitted", "cancelled"],
  submitted: ["approved", "draft", "cancelled"], // → draft = rejected
  approved: ["applied", "cancelled"],
  applied: [], // correction = a new adjustment
  cancelled: [],
});

export const GRANTS: Record<AdjustmentKind, { create: string; submit: string; approve: string }> = {
  adjustment: { create: "inventory.adjust_create", submit: "inventory.adjust_submit", approve: "inventory.adjust_approve" },
  damage: { create: "inventory.damage_mark", submit: "inventory.damage_mark", approve: "inventory.damage_approve" },
  repair: { create: "inventory.damage_mark", submit: "inventory.damage_mark", approve: "inventory.repair_approve" },
  disposal: { create: "inventory.damage_mark", submit: "inventory.damage_mark", approve: "inventory.dispose_approve" },
};

type PhysicalBucket = Exclude<Bucket, "reserved" | "onHand">;
export type AdjustmentLineInput = {
  variantId: string;
  qty: DecValue; // adjustment: signed (+ found / − loss); others: > 0
  batchId?: string | null;
  binId?: string | null;
  bucket?: PhysicalBucket | null; // disposal: which bucket is written off
  unitCost?: DecValue | null; // adjustment in; default current WAC
  serials?: string[];
};

const s4 = (d: Dec) => d.toFixed(4);
const ZERO = dec(0);

export async function createAdjustment(
  tx: Tx,
  ctx: Ctx,
  input: { kind: AdjustmentKind; warehouseId: string; reasonCode: string; note?: string | null; lines: AdjustmentLineInput[] },
) {
  await requirePermission(ctx, GRANTS[input.kind].create, { warehouseId: input.warehouseId });
  const wh = await tx.warehouse.findFirst({ where: { id: input.warehouseId, companyId: ctx.companyId } });
  if (!wh) throw new AppError("validation_error", "Unknown warehouse", { field: "warehouseId" });
  if (wh.status !== "active") throw new AppError("archived_conflict", `Warehouse is ${wh.status}`, { field: "warehouseId" });
  const reasonCode = input.reasonCode?.trim();
  if (!reasonCode || reasonCode.length > 50) throw new AppError("validation_error", "A reason code is required (max 50 chars)", { field: "reasonCode" });
  if (!input.lines.length) throw new AppError("validation_error", "Add at least one line", { field: "lines" });

  const lines: Prisma.StockAdjustmentLineCreateManyAdjustmentInput[] = [];
  for (const [i, l] of input.lines.entries()) {
    const v = await tx.productVariant.findFirst({ where: { id: l.variantId, companyId: ctx.companyId }, include: { product: true } });
    if (!v) throw new AppError("validation_error", "Unknown variant", { field: "variantId" });
    assertTransactable(v, "existing"); // INV-019: archived blocks; discontinued stock may still be corrected
    const sku = v.sku;
    const q = dec(l.qty);
    if (q.isZero() || q.decimalPlaces() > 4 || (input.kind !== "adjustment" && q.isNeg())) {
      throw new AppError("validation_error", `${sku}: quantity must be ${input.kind === "adjustment" ? "≠ 0" : "> 0"} (max 4 decimals)`, { field: "qty", sku });
    }
    if (v.product.isSerialized) {
      // ponytail: serialized found/loss needs unit capture; it arrives with stock counts (Part 8).
      if (input.kind === "adjustment") throw new AppError("validation_error", `${sku} is serialized: correct it with a stock count`, { field: "variantId", sku });
      if (!q.isInteger() || (l.serials ?? []).filter(Boolean).length !== q.toNumber()) {
        throw new AppError("validation_error", `${sku}: list exactly ${q.toString()} serial number(s)`, { field: "serials", sku });
      }
    } else if (l.serials?.length) {
      throw new AppError("validation_error", `${sku} is not serialized`, { field: "serials", sku });
    }
    if (v.product.requiresBatch !== !!l.batchId) {
      throw new AppError("validation_error", v.product.requiresBatch ? `Pick the batch for ${sku}` : `${sku} is not batch-tracked`, { field: "batchId", sku });
    }
    if (l.batchId && !(await tx.batch.findFirst({ where: { id: l.batchId, variantId: v.id } }))) throw new AppError("validation_error", "Batch not found for variant", { field: "batchId", sku });
    if (l.binId) {
      const bin = await tx.bin.findFirst({ where: { id: l.binId, warehouseId: wh.id, archived: false } });
      if (!bin) throw new AppError("validation_error", "Bin not found in warehouse", { field: "binId", sku });
      if (input.kind === "adjustment" && q.gt(0) && bin.type !== "sellable" && bin.type !== "receiving") {
        throw new AppError("validation_error", "Found stock goes into a sellable or receiving bin", { field: "binId", sku });
      }
    }
    if ((input.kind === "disposal") !== !!l.bucket) {
      throw new AppError("validation_error", input.kind === "disposal" ? `${sku}: choose damaged, expired or blocked` : "Only disposals name a bucket", { field: "bucket", sku });
    }
    if (l.unitCost != null && !(input.kind === "adjustment" && q.gt(0))) throw new AppError("validation_error", "Only found stock (adjustment in) takes a unit cost", { field: "unitCost", sku });
    if (l.unitCost != null && (dec(l.unitCost).isNeg() || dec(l.unitCost).decimalPlaces() > 4)) throw new AppError("validation_error", "Unit cost: ≥ 0, max 4 decimals", { field: "unitCost", sku });
    lines.push({
      lineNo: i + 1, variantId: v.id, batchId: l.batchId ?? null, binId: l.binId ?? null, qty: s4(q),
      bucket: l.bucket ?? null, unitCost: l.unitCost == null ? null : s4(dec(l.unitCost)), serials: (l.serials ?? []).map((x) => x.trim()).filter(Boolean),
    });
  }
  const year = new Date().getUTCFullYear();
  const adj = await tx.stockAdjustment.create({
    data: {
      companyId: ctx.companyId, number: await nextNumber(tx, ctx.companyId, `adj:${year}`, `ADJ-${year}-`, 5),
      kind: input.kind, warehouseId: wh.id, reasonCode, note: input.note?.trim() || null, createdBy: ctx.userId,
      lines: { createMany: { data: lines } },
    },
    include: { lines: { orderBy: { lineNo: "asc" } } },
  });
  await writeAudit(tx, ctx, { action: "create", entityType: "stock_adjustment", entityId: adj.id, warehouseId: wh.id, after: adj });
  return adj;
}

// version given → stale writes fail right after the lock, before anything posts (I-08, edge #33).
async function lockAdjustment(tx: Tx, ctx: Ctx, id: string, version?: number) {
  await tx.$executeRaw`SELECT 1 FROM stock_adjustment WHERE id = ${id} AND company_id = ${ctx.companyId} FOR UPDATE`;
  const a = await tx.stockAdjustment.findFirst({
    where: { id, companyId: ctx.companyId },
    include: { lines: { orderBy: { lineNo: "asc" }, include: { variant: { include: { product: true } } } } },
  });
  if (!a) throw new AppError("not_found", "Adjustment not found");
  if (version !== undefined && version !== a.version) throw new AppError("version_conflict", "Adjustment was changed by someone else", { currentVersion: a.version });
  return a;
}
type Locked = Awaited<ReturnType<typeof lockAdjustment>>;

async function move(tx: Tx, a: { id: string; version: number; status: AdjustmentStatus }, version: number, to: AdjustmentStatus, data: Prisma.StockAdjustmentUpdateManyMutationInput = {}) {
  ADJ.assert(a.status, to);
  assertVersion(await tx.stockAdjustment.updateMany({
    where: { id: a.id, version, status: a.status },
    data: { ...data, status: to, version: { increment: 1 } },
  }), "Adjustment", a.version);
}

async function done(tx: Tx, ctx: Ctx, before: Locked, action: string, extra: object = {}) {
  const after = await tx.stockAdjustment.findUniqueOrThrow({ where: { id: before.id }, include: { lines: { orderBy: { lineNo: "asc" } } } });
  const audit = await writeAudit(tx, ctx, {
    action, entityType: "stock_adjustment", entityId: before.id, warehouseId: before.warehouseId,
    before: { status: before.status, version: before.version }, after: { status: after.status, version: after.version, ...extra },
  });
  return { ...after, ...extra, auditId: audit.id };
}

// INV-020 amount: |qty| × (given unit cost, else current WAC).
export async function adjustmentValue(tx: Tx | typeof db, a: { warehouseId: string; lines: { variantId: string; qty: DecValue; unitCost: DecValue | null }[] }) {
  const costs = await tx.variantCost.findMany({ where: { warehouseId: a.warehouseId, variantId: { in: a.lines.map((l) => l.variantId) } } });
  return a.lines.reduce((t, l) => {
    const c = costs.find((x) => x.variantId === l.variantId);
    const unit = l.unitCost != null ? dec(l.unitCost) : c && !dec(c.qty).isZero() ? dec(c.value).div(dec(c.qty)) : ZERO;
    return t.plus(dec(l.qty).abs().times(unit));
  }, ZERO).toDecimalPlaces(4);
}

export async function submitAdjustment(tx: Tx, ctx: Ctx, input: { id: string; version: number }) {
  const a = await lockAdjustment(tx, ctx, input.id, input.version);
  await requirePermission(ctx, GRANTS[a.kind].submit, { warehouseId: a.warehouseId }); // INV-018
  await move(tx, a, input.version, "submitted");
  return done(tx, ctx, a, "submit");
}

export async function approveAdjustment(tx: Tx, ctx: Ctx, input: { id: string; version: number; comment?: string | null }) {
  const a = await lockAdjustment(tx, ctx, input.id, input.version);
  const amount = await adjustmentValue(tx, a);
  await requirePermission(ctx, GRANTS[a.kind].approve, { warehouseId: a.warehouseId, amount });
  await requireNotCreator(ctx, a.createdBy, { type: "stock_adjustment", id: a.id });
  await move(tx, a, input.version, "approved", { approvedBy: ctx.userId, approvedAt: new Date() });
  await tx.approval.create({ data: { companyId: ctx.companyId, entityType: "stock_adjustment", entityId: a.id, actorId: ctx.userId, decision: "approved", amount: s4(amount), comment: input.comment?.trim() || null } });
  if (a.kind !== "adjustment") {
    const posted = await post(tx, ctx, a);
    await move(tx, { ...a, status: "approved", version: a.version + 1 }, a.version + 1, "applied", { appliedBy: ctx.userId, appliedAt: new Date() });
    return done(tx, ctx, a, "approve_apply", { movementIds: posted });
  }
  await notify(tx, ctx, { type: "adjustment.approved", entityType: "stock_adjustment", entityId: a.id, warehouseId: a.warehouseId, message: `${a.number} approved — ready to apply`, link: `/adjustments/${a.id}` });
  return done(tx, ctx, a, "approve");
}

export async function rejectAdjustment(tx: Tx, ctx: Ctx, input: { id: string; version: number; comment: string }) {
  const a = await lockAdjustment(tx, ctx, input.id, input.version);
  await requirePermission(ctx, GRANTS[a.kind].approve, { warehouseId: a.warehouseId });
  await requireNotCreator(ctx, a.createdBy, { type: "stock_adjustment", id: a.id });
  if (!input.comment?.trim()) throw new AppError("validation_error", "A rejection needs a comment", { field: "comment" });
  if (a.status !== "submitted") throw new AppError("invalid_transition", `Only a submitted adjustment can be rejected (is ${a.status})`, { from: a.status, to: "draft" });
  await move(tx, a, input.version, "draft");
  await tx.approval.create({ data: { companyId: ctx.companyId, entityType: "stock_adjustment", entityId: a.id, actorId: ctx.userId, decision: "rejected", comment: input.comment.trim() } });
  await notify(tx, ctx, { type: "adjustment.rejected", entityType: "stock_adjustment", entityId: a.id, userId: a.createdBy, message: `${a.number} sent back: ${input.comment.trim()}`, link: `/adjustments/${a.id}` });
  return done(tx, ctx, a, "reject");
}

// Flow 12: one transaction; fails on a negative bucket (INV-003) or reserved units (I-07).
export async function applyAdjustment(tx: Tx, ctx: Ctx, input: { id: string; version: number }) {
  const a = await lockAdjustment(tx, ctx, input.id, input.version);
  await requirePermission(ctx, "inventory.adjust_apply", { warehouseId: a.warehouseId });
  if (a.kind !== "adjustment") throw new AppError("invalid_transition", `A ${a.kind} is applied on approval`, { kind: a.kind });
  ADJ.assert(a.status, "applied");
  const posted = await post(tx, ctx, a);
  await move(tx, a, input.version, "applied", { appliedBy: ctx.userId, appliedAt: new Date() });
  return done(tx, ctx, a, "apply", { movementIds: posted });
}

export async function cancelAdjustment(tx: Tx, ctx: Ctx, input: { id: string; version: number }) {
  const a = await lockAdjustment(tx, ctx, input.id, input.version);
  await requirePermission(ctx, [GRANTS[a.kind].create, GRANTS[a.kind].approve], { warehouseId: a.warehouseId });
  await move(tx, a, input.version, "cancelled");
  return done(tx, ctx, a, "cancel");
}

// Serial state the unit must be in before / goes to after each kind (I-06).
const SERIAL_FROM: Record<Exclude<AdjustmentKind, "adjustment">, (bucket: string | null) => SerialStatus[]> = {
  damage: () => ["in_stock"],
  repair: () => ["damaged"],
  disposal: (b) => (b === "blocked" ? ["quarantine"] : ["damaged"]),
};
const SERIAL_TO: Record<Exclude<AdjustmentKind, "adjustment">, SerialStatus> = { damage: "damaged", repair: "in_stock", disposal: "disposed" };

async function post(tx: Tx, ctx: Ctx, a: Locked): Promise<string[]> {
  await lockPositions(tx, ctx, a.lines.map((l) => [l.variantId, a.warehouseId, l.batchId] as const));
  const legs: Leg[] = [];
  const serialMoves: { ids: string[]; to: SerialStatus }[] = [];
  let sellableBin: string | null = null;
  for (const l of a.lines) {
    const q = dec(l.qty);
    const base = { variantId: l.variantId, warehouseId: a.warehouseId, batchId: l.batchId, line: l.lineNo, reasonCode: a.reasonCode, note: a.note ?? undefined };
    const push = (binId: string, leg: Omit<Leg, keyof typeof base | "binId" | "leg">) =>
      legs.push({ ...base, ...leg, binId, leg: legs.filter((x) => x.line === l.lineNo).length + 1 });

    if (a.kind === "adjustment" && q.gt(0)) {
      sellableBin ??= l.binId ? null : (await tx.bin.findFirst({ where: { warehouseId: a.warehouseId, isDefaultSellable: true, archived: false } }))?.id ?? null;
      const binId = l.binId ?? sellableBin;
      if (!binId) throw new AppError("conflict", "Warehouse has no default sellable bin", { reason: "missing_bin" });
      push(binId, { type: "adjustment_in", delta: { onHand: q }, ...(l.unitCost != null ? { unitCost: l.unitCost } : {}) });
      continue;
    }
    const kind = a.kind === "adjustment" ? null : a.kind;
    const bucket: Exclude<Bucket, "reserved"> = kind === "repair" ? "damaged" : kind === "disposal" ? (l.bucket as PhysicalBucket) : "onHand";
    const n = q.abs();
    const delta = (k: Dec): Leg["delta"] =>
      kind === null ? { onHand: k.neg() }
      : kind === "damage" ? { onHand: k.neg(), damaged: k }
      : kind === "repair" ? { damaged: k.neg(), onHand: k }
      : { [bucket]: k.neg() };
    const type = kind === null ? "adjustment_out" : kind === "repair" ? "repair_to_stock" : kind;
    if (l.variant.product.isSerialized && kind) {
      const units = await takeSerials(tx, ctx, {
        sku: l.variant.sku, variantId: l.variantId, warehouseId: a.warehouseId, batchId: l.batchId, qty: n, serials: l.serials, status: SERIAL_FROM[kind](l.bucket),
      });
      if (l.binId && units.some((u) => u.binId !== l.binId)) throw new AppError("validation_error", `${l.variant.sku}: serial(s) are not in the chosen bin`, { field: "serials" });
      serialMoves.push({ ids: units.map((u) => u.id), to: SERIAL_TO[kind] });
      for (const b of perBin(units)) push(b.binId, { type, delta: delta(dec(b.qty)), serialized: true });
    } else {
      for (const b of await pickBins(tx, ctx, { variantId: l.variantId, warehouseId: a.warehouseId, batchId: l.batchId, qty: n, bucket, binId: l.binId })) {
        push(b.binId, { type, delta: delta(b.qty) });
      }
    }
  }
  const posted = await postMovements(tx, ctx, { sourceType: "stock_adjustment", sourceId: a.id, action: a.kind === "adjustment" ? "apply" : a.kind, legs });
  for (const m of serialMoves) await tx.serialUnit.updateMany({ where: { id: { in: m.ids } }, data: { status: m.to, version: { increment: 1 } } });
  return posted.movements.map((m) => m.id);
}

// ───────────── Reads ─────────────

export async function listAdjustments(
  ctx: Ctx,
  input: { page: number; perPage: number; status?: AdjustmentStatus; kind?: AdjustmentKind; warehouseId?: string; q?: string },
) {
  await requirePermission(ctx, "inventory.view", { warehouseId: input.warehouseId });
  const q = input.q?.trim();
  const where: Prisma.StockAdjustmentWhereInput = {
    companyId: ctx.companyId, status: input.status, kind: input.kind, warehouseId: scopeFilter(ctx, input.warehouseId),
    ...(q ? { number: { contains: q.toUpperCase() } } : {}),
  };
  const [total, items] = await Promise.all([
    db.stockAdjustment.count({ where }),
    db.stockAdjustment.findMany({
      where, orderBy: { createdAt: "desc" }, skip: (input.page - 1) * input.perPage, take: input.perPage,
      include: { warehouse: { select: { code: true } }, _count: { select: { lines: true } } },
    }),
  ]);
  return { total, page: input.page, perPage: input.perPage, items };
}

export async function getAdjustment(ctx: Ctx, id: string) {
  const a = await db.stockAdjustment.findFirst({
    where: { id, companyId: ctx.companyId },
    include: {
      warehouse: { select: { id: true, code: true, name: true } },
      creator: { select: { id: true, name: true } },
      lines: {
        orderBy: { lineNo: "asc" },
        include: { variant: { select: { sku: true, product: { select: { name: true } } } }, batch: { select: { batchNo: true } }, bin: { select: { code: true } } },
      },
    },
  });
  if (!a) throw new AppError("not_found", "Adjustment not found");
  await requirePermission(ctx, "inventory.view", { warehouseId: a.warehouseId });
  const [approvals, movements, value] = await Promise.all([
    db.approval.findMany({ where: { companyId: ctx.companyId, entityType: "stock_adjustment", entityId: a.id }, orderBy: { createdAt: "asc" }, include: { actor: { select: { name: true } } } }),
    db.inventoryMovement.findMany({ where: { companyId: ctx.companyId, sourceType: "stock_adjustment", sourceId: a.id }, orderBy: { id: "asc" }, include: { bin: { select: { code: true } } } }),
    adjustmentValue(db, a),
  ]);
  return { ...a, approvals, movements, value };
}
