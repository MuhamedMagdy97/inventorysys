import type { CountStatus, Prisma } from "@/generated/prisma/client";
import { assertTransactable } from "@/server/catalog/catalog";
import { writeAudit } from "@/server/core/audit";
import { deny, requirePermission, scopeFilter, type Ctx } from "@/server/core/ctx";
import { AppError, assertVersion } from "@/server/core/errors";
import { nextNumber } from "@/server/core/sequences";
import { stateMachine } from "@/server/core/state";
import { db, type Tx } from "@/server/db";
import { readSettings } from "@/server/settings/settings";
import { Dec, dec, lockPositions, postMovements, type DecValue, type Leg } from "./post";

// Flow 19 / doc 23 / INV-023 stock counts. No freeze: postings go on while counting.
// Each count entry records the bin's system on_hand at that moment (under the position
// lock); variance = counted − that, posted at apply under lock against the current balance.

export const COUNT = stateMachine<CountStatus>("Count", {
  open: ["counting", "cancelled"],
  counting: ["counting", "variance_review", "cancelled"], // counting → counting = forced recount
  variance_review: ["approved", "counting", "cancelled"], // → counting = recount
  approved: ["applied", "cancelled"],
  applied: [],
  cancelled: [],
});
export const OPEN_COUNT: CountStatus[] = ["open", "counting", "variance_review", "approved"];

const s4 = (d: Dec) => d.toFixed(4);
const ZERO = dec(0);
const LIVE_HERE = ["in_stock", "reserved"] as const;

export async function openCount(
  tx: Tx,
  ctx: Ctx,
  input: { warehouseId: string; binId?: string | null; variantIds?: string[]; note?: string | null },
) {
  await requirePermission(ctx, "inventory.count_create", { warehouseId: input.warehouseId });
  const wh = await tx.warehouse.findFirst({ where: { id: input.warehouseId, companyId: ctx.companyId } });
  if (!wh) throw new AppError("validation_error", "Unknown warehouse", { field: "warehouseId" });
  if (wh.status !== "active") throw new AppError("archived_conflict", `Warehouse is ${wh.status}`, { field: "warehouseId" });
  if (input.binId && !(await tx.bin.findFirst({ where: { id: input.binId, warehouseId: wh.id, archived: false } }))) {
    throw new AppError("validation_error", "Bin not found in warehouse", { field: "binId" });
  }
  const variantIds = [...new Set(input.variantIds ?? [])];
  if (variantIds.length && (await tx.productVariant.count({ where: { id: { in: variantIds }, companyId: ctx.companyId } })) !== variantIds.length) {
    throw new AppError("validation_error", "Unknown variant in scope", { field: "variantIds" });
  }
  const snapshotAt = new Date();
  const rows = await tx.stockBalance.findMany({
    where: {
      companyId: ctx.companyId, warehouseId: wh.id, onHand: { gt: 0 }, bin: { archived: false },
      ...(input.binId ? { binId: input.binId } : {}), ...(variantIds.length ? { variantId: { in: variantIds } } : {}),
    },
    include: { bin: { select: { code: true } }, variant: { select: { sku: true } } },
  });
  rows.sort((a, b) => a.bin.code.localeCompare(b.bin.code) || a.variant.sku.localeCompare(b.variant.sku));
  const year = snapshotAt.getUTCFullYear();
  const count = await tx.stockCount.create({
    data: {
      companyId: ctx.companyId, number: await nextNumber(tx, ctx.companyId, `cnt:${year}`, `CNT-${year}-`, 5),
      warehouseId: wh.id, binId: input.binId ?? null, variantIds, snapshotAt, note: input.note?.trim() || null, createdBy: ctx.userId,
      lines: { createMany: { data: rows.map((r, i) => ({ lineNo: i + 1, binId: r.binId, variantId: r.variantId, batchId: r.batchId, snapshotQty: r.onHand })) } },
    },
    include: { lines: { orderBy: { lineNo: "asc" } } },
  });
  await writeAudit(tx, ctx, { action: "create", entityType: "stock_count", entityId: count.id, warehouseId: wh.id, after: { ...count, lines: count.lines.length } });
  return count;
}

async function lockCount(tx: Tx, ctx: Ctx, id: string, version?: number) {
  await tx.$executeRaw`SELECT 1 FROM stock_count WHERE id = ${id} AND company_id = ${ctx.companyId} FOR UPDATE`;
  const c = await tx.stockCount.findFirst({
    where: { id, companyId: ctx.companyId },
    include: { lines: { orderBy: { lineNo: "asc" }, include: { variant: { include: { product: true } } } } },
  });
  if (!c) throw new AppError("not_found", "Count not found");
  if (version !== undefined && version !== c.version) throw new AppError("version_conflict", "Count was changed by someone else", { currentVersion: c.version });
  return c;
}
type Locked = Awaited<ReturnType<typeof lockCount>>;

async function move(tx: Tx, c: { id: string; version: number; status: CountStatus }, to: CountStatus, data: Prisma.StockCountUpdateManyMutationInput = {}) {
  COUNT.assert(c.status, to);
  assertVersion(await tx.stockCount.updateMany({
    where: { id: c.id, version: c.version, status: c.status },
    data: { ...data, status: to, version: { increment: 1 } },
  }), "Count", c.version);
}

async function done(tx: Tx, ctx: Ctx, before: Locked, action: string, extra: object = {}) {
  const after = await tx.stockCount.findUniqueOrThrow({ where: { id: before.id }, include: { lines: { orderBy: { lineNo: "asc" } } } });
  const audit = await writeAudit(tx, ctx, {
    action, entityType: "stock_count", entityId: before.id, warehouseId: before.warehouseId,
    before: { status: before.status, version: before.version }, after: { status: after.status, version: after.version, ...extra },
  });
  return { ...after, ...extra, auditId: audit.id };
}

export type CountEntry = {
  lineId?: string; // a snapshot line …
  binId?: string; variantId?: string; batchId?: string | null; // … or an item found where the snapshot had none
  countedQty?: DecValue; // non-serialized
  serials?: string[]; // serialized: every unit scanned in that bin
};

// Count entry (scan). Allowed while open/counting; several counters may work at once.
export async function enterCounts(tx: Tx, ctx: Ctx, input: { id: string; entries: CountEntry[] }) {
  const c = await lockCount(tx, ctx, input.id);
  await requirePermission(ctx, "inventory.count_submit", { warehouseId: c.warehouseId });
  if (c.status !== "open" && c.status !== "counting") throw new AppError("invalid_transition", `Counting is closed (count is ${c.status})`, { from: c.status, to: "counting" });
  if (!input.entries.length) throw new AppError("validation_error", "Nothing counted", { field: "entries" });
  let nextNo = c.lines.reduce((m, l) => Math.max(m, l.lineNo), 0);
  const touched: string[] = [];
  for (const e of input.entries) {
    let line = e.lineId ? c.lines.find((l) => l.id === e.lineId) : c.lines.find((l) => l.binId === e.binId && l.variantId === e.variantId && l.batchId === (e.batchId ?? null));
    if (e.lineId && !line) throw new AppError("not_found", "Count line not found");
    if (!line) line = await addFoundLine(tx, ctx, c, e, ++nextNo);
    const v = line.variant;
    const sku = v.sku;
    // The position lock serialises this read with every posting to it (lock order: allocation first).
    await lockPositions(tx, ctx, [[line.variantId, c.warehouseId, line.batchId]]);
    const bal = await tx.stockBalance.findFirst({ where: { binId: line.binId, variantId: line.variantId, batchId: line.batchId } });
    let counted: Dec;
    let countedSerials: string[] = [];
    let systemSerials: string[] = [];
    if (v.product.isSerialized) {
      countedSerials = [...new Set((e.serials ?? []).map((x) => x.trim()).filter(Boolean))];
      if (e.countedQty != null && !dec(e.countedQty).eq(countedSerials.length)) {
        throw new AppError("validation_error", `${sku}: scan every unit (S-02); ${countedSerials.length} serial(s) for qty ${dec(e.countedQty).toString()}`, { field: "serials", sku });
      }
      counted = dec(countedSerials.length);
      systemSerials = (await tx.serialUnit.findMany({
        where: { companyId: ctx.companyId, variantId: line.variantId, warehouseId: c.warehouseId, binId: line.binId, batchId: line.batchId, status: { in: [...LIVE_HERE] } },
        select: { serialNo: true },
      })).map((u) => u.serialNo);
      const foreign = await tx.serialUnit.findMany({
        where: { companyId: ctx.companyId, serialNo: { in: countedSerials.filter((n) => !systemSerials.includes(n)) }, status: { not: "reversed" } },
      });
      const bad = foreign.filter((u) => u.variantId !== line.variantId || u.status !== "lost");
      if (bad.length) {
        throw new AppError("validation_error", `${sku}: serial(s) recorded elsewhere or for another item: ${bad.map((u) => u.serialNo).join(", ")}`, { field: "serials", sku, serials: bad.map((u) => u.serialNo) });
      }
    } else {
      if (e.serials?.length) throw new AppError("validation_error", `${sku} is not serialized`, { field: "serials", sku });
      counted = dec(e.countedQty);
      if (e.countedQty == null || counted.isNeg() || counted.decimalPlaces() > 4) throw new AppError("validation_error", `${sku}: counted qty ≥ 0, max 4 decimals`, { field: "countedQty", sku });
    }
    const recount = line.recountRequested;
    await tx.stockCountLine.update({
      where: { id: line.id },
      data: {
        countedQty: s4(counted), countedSerials, systemQty: bal?.onHand ?? 0, systemSerials, countedBy: ctx.userId, countedAt: new Date(),
        ...(recount ? { recountRequested: false, recounts: { increment: 1 } } : {}),
      },
    });
    touched.push(line.id);
  }
  await move(tx, c, "counting", c.counters.includes(ctx.userId) ? {} : { counters: { push: ctx.userId } });
  return done(tx, ctx, c, "count_entry", { lineIds: touched });
}

async function addFoundLine(tx: Tx, ctx: Ctx, c: Locked, e: CountEntry, lineNo: number) {
  if (!e.binId || !e.variantId) throw new AppError("validation_error", "Give a line, or the bin and item found", { field: "lineId" });
  if (c.binId && e.binId !== c.binId) throw new AppError("validation_error", "This count covers one bin only", { field: "binId" });
  if (c.variantIds.length && !c.variantIds.includes(e.variantId)) throw new AppError("validation_error", "Item is outside this count's scope", { field: "variantId" });
  const bin = await tx.bin.findFirst({ where: { id: e.binId, warehouseId: c.warehouseId, archived: false } });
  if (!bin) throw new AppError("validation_error", "Bin not found in warehouse", { field: "binId" });
  const v = await tx.productVariant.findFirst({ where: { id: e.variantId, companyId: ctx.companyId }, include: { product: true } });
  if (!v) throw new AppError("validation_error", "Unknown variant", { field: "variantId" });
  assertTransactable(v, "existing");
  if (v.product.requiresBatch !== !!e.batchId) throw new AppError("validation_error", v.product.requiresBatch ? `Pick the batch for ${v.sku}` : `${v.sku} is not batch-tracked`, { field: "batchId", sku: v.sku });
  if (e.batchId && !(await tx.batch.findFirst({ where: { id: e.batchId, variantId: v.id } }))) throw new AppError("validation_error", "Batch not found for variant", { field: "batchId", sku: v.sku });
  const line = await tx.stockCountLine.create({ data: { countId: c.id, lineNo, binId: bin.id, variantId: v.id, batchId: e.batchId ?? null } });
  const withVariant = { ...line, variant: v };
  c.lines.push(withVariant);
  return withVariant;
}

const varianceOf = (l: { countedQty: DecValue | null; systemQty: DecValue | null }) => dec(l.countedQty).minus(dec(l.systemQty));
function isLarge(l: { countedQty: DecValue | null; systemQty: DecValue | null }, pct: number) {
  const v = varianceOf(l).abs();
  const sys = dec(l.systemQty);
  return sys.isZero() ? !v.isZero() : v.gt(sys.times(pct).div(100));
}

// Submit → variance review; un-recounted large variances go back to counting first (doc 23).
export async function submitCount(tx: Tx, ctx: Ctx, input: { id: string; version: number }) {
  const c = await lockCount(tx, ctx, input.id, input.version);
  await requirePermission(ctx, "inventory.count_submit", { warehouseId: c.warehouseId });
  COUNT.assert(c.status, "variance_review");
  const open = c.lines.filter((l) => l.countedQty == null || l.recountRequested);
  if (open.length) throw new AppError("validation_error", `${open.length} line(s) still to count`, { field: "lines", lineNos: open.map((l) => l.lineNo) });
  const { countRecountPct } = await readSettings(tx, ctx.companyId);
  const recount = c.lines.filter((l) => l.recounts === 0 && isLarge(l, countRecountPct));
  if (recount.length) {
    await tx.stockCountLine.updateMany({ where: { id: { in: recount.map((l) => l.id) } }, data: { recountRequested: true } });
    await move(tx, c, "counting");
    return done(tx, ctx, c, "recount_forced", { recountLineNos: recount.map((l) => l.lineNo), thresholdPct: countRecountPct });
  }
  await move(tx, c, "variance_review");
  return done(tx, ctx, c, "submit");
}

// Reviewer sends chosen lines back for a recount.
export async function recountCount(tx: Tx, ctx: Ctx, input: { id: string; version: number; lineIds: string[] }) {
  const c = await lockCount(tx, ctx, input.id, input.version);
  await requirePermission(ctx, ["inventory.count_approve", "inventory.count_create"], { warehouseId: c.warehouseId });
  const ids = c.lines.filter((l) => input.lineIds.includes(l.id)).map((l) => l.id);
  if (!ids.length || ids.length !== new Set(input.lineIds).size) throw new AppError("validation_error", "Choose lines of this count to recount", { field: "lineIds" });
  await move(tx, c, "counting");
  await tx.stockCountLine.updateMany({ where: { id: { in: ids } }, data: { recountRequested: true } });
  return done(tx, ctx, c, "recount", { lineIds: ids });
}

// INV-020 amount: Σ |variance| × current WAC.
export async function countValue(tx: Tx | typeof db, c: { warehouseId: string; lines: { variantId: string; countedQty: DecValue | null; systemQty: DecValue | null }[] }) {
  const costs = await tx.variantCost.findMany({ where: { warehouseId: c.warehouseId, variantId: { in: c.lines.map((l) => l.variantId) } } });
  return c.lines.reduce((t, l) => {
    const k = costs.find((x) => x.variantId === l.variantId);
    const unit = k && !dec(k.qty).isZero() ? dec(k.value).div(dec(k.qty)) : ZERO;
    return l.countedQty == null ? t : t.plus(varianceOf(l).abs().times(unit));
  }, ZERO).toDecimalPlaces(4);
}

export async function approveCount(tx: Tx, ctx: Ctx, input: { id: string; version: number; comment?: string | null }) {
  const c = await lockCount(tx, ctx, input.id, input.version);
  const amount = await countValue(tx, c);
  await requirePermission(ctx, "inventory.count_approve", { warehouseId: c.warehouseId, amount });
  if (c.createdBy === ctx.userId || c.counters.includes(ctx.userId)) {
    throw await deny(ctx, "Approver must not have opened or counted this count", { reason: "creator_is_approver" }, { type: "stock_count", id: c.id });
  }
  await move(tx, c, "approved", { approvedBy: ctx.userId, approvedAt: new Date() });
  await tx.approval.create({ data: { companyId: ctx.companyId, entityType: "stock_count", entityId: c.id, actorId: ctx.userId, decision: "approved", amount: s4(amount), comment: input.comment?.trim() || null } });
  return done(tx, ctx, c, "approve");
}

// INV-023: variance applied to the current balance under the position + bin locks.
export async function applyCount(tx: Tx, ctx: Ctx, input: { id: string; version: number }) {
  const c = await lockCount(tx, ctx, input.id, input.version);
  await requirePermission(ctx, "inventory.count_apply", { warehouseId: c.warehouseId });
  COUNT.assert(c.status, "applied");
  await lockPositions(tx, ctx, c.lines.map((l) => [l.variantId, c.warehouseId, l.batchId] as const));
  const legs: Leg[] = [];
  const lost: string[] = [];
  const found: { line: Locked["lines"][number]; serialNo: string }[] = [];
  for (const l of c.lines) {
    const bal = await tx.stockBalance.findFirst({ where: { binId: l.binId, variantId: l.variantId, batchId: l.batchId } });
    const base = { variantId: l.variantId, warehouseId: c.warehouseId, batchId: l.batchId, binId: l.binId, line: l.lineNo, reasonCode: "count", note: c.number };
    let plus = ZERO, minus = ZERO;
    if (l.variant.product.isSerialized) {
      const missing = l.systemSerials.filter((n) => !l.countedSerials.includes(n));
      const units = await tx.serialUnit.findMany({
        where: { companyId: ctx.companyId, variantId: l.variantId, serialNo: { in: missing }, warehouseId: c.warehouseId, binId: l.binId, status: { in: [...LIVE_HERE] } },
      });
      if (units.some((u) => u.status === "reserved")) {
        throw new AppError("reserved_conflict", `${l.variant.sku}: a missing unit is reserved; release it first`, { serials: units.filter((u) => u.status === "reserved").map((u) => u.serialNo) });
      }
      lost.push(...units.map((u) => u.id)); // units that left since the count are already gone
      for (const serialNo of l.countedSerials.filter((n) => !l.systemSerials.includes(n))) found.push({ line: l, serialNo });
      plus = dec(l.countedSerials.filter((n) => !l.systemSerials.includes(n)).length);
      minus = dec(units.length);
    } else {
      const v = varianceOf(l);
      if (v.gt(0)) plus = v; else minus = v.neg();
    }
    const serialized = l.variant.product.isSerialized ? { serialized: true as const } : {};
    if (plus.gt(0)) legs.push({ ...base, leg: 1, type: "adjustment_in", delta: { onHand: plus }, ...serialized });
    if (minus.gt(0)) legs.push({ ...base, leg: 2, type: "adjustment_out", delta: { onHand: minus.neg() }, ...serialized });
    await tx.stockCountLine.update({ where: { id: l.id }, data: { qtyAtApply: bal?.onHand ?? 0, variance: s4(plus.minus(minus)) } });
  }
  const posted = legs.length ? await postMovements(tx, ctx, { sourceType: "stock_count", sourceId: c.id, action: "apply", legs }) : null;
  if (lost.length) await tx.serialUnit.updateMany({ where: { id: { in: lost } }, data: { status: "lost", version: { increment: 1 } } });
  for (const f of found) {
    const at = { warehouseId: c.warehouseId, binId: f.line.binId, batchId: f.line.batchId, status: "in_stock" as const };
    const again = await tx.serialUnit.updateMany({
      where: { companyId: ctx.companyId, variantId: f.line.variantId, serialNo: f.serialNo, status: "lost" },
      data: { ...at, version: { increment: 1 } },
    });
    if (again.count === 0) {
      // fromDbError maps a race on the live-serial index to `duplicate`.
      await tx.serialUnit.create({ data: { companyId: ctx.companyId, variantId: f.line.variantId, serialNo: f.serialNo, ...at } });
    }
  }
  await move(tx, c, "applied", { appliedBy: ctx.userId, appliedAt: new Date() });
  return done(tx, ctx, c, "apply", { movementIds: posted?.movements.map((m) => m.id) ?? [] });
}

export async function cancelCount(tx: Tx, ctx: Ctx, input: { id: string; version: number }) {
  const c = await lockCount(tx, ctx, input.id, input.version);
  await requirePermission(ctx, ["inventory.count_create", "inventory.count_approve"], { warehouseId: c.warehouseId });
  await move(tx, c, "cancelled");
  return done(tx, ctx, c, "cancel");
}

// ───────────── Reads ─────────────

export async function listCounts(ctx: Ctx, input: { page: number; perPage: number; status?: CountStatus; warehouseId?: string; q?: string }) {
  await requirePermission(ctx, "inventory.view", { warehouseId: input.warehouseId });
  const q = input.q?.trim();
  const where: Prisma.StockCountWhereInput = {
    companyId: ctx.companyId, status: input.status, warehouseId: scopeFilter(ctx, input.warehouseId),
    ...(q ? { number: { contains: q.toUpperCase() } } : {}),
  };
  const [total, items] = await Promise.all([
    db.stockCount.count({ where }),
    db.stockCount.findMany({
      where, orderBy: { createdAt: "desc" }, skip: (input.page - 1) * input.perPage, take: input.perPage,
      include: { warehouse: { select: { code: true } }, bin: { select: { code: true } }, _count: { select: { lines: true } } },
    }),
  ]);
  return { total, page: input.page, perPage: input.perPage, items };
}

// Snapshot + entries + live variance view (current qty and what apply would leave).
export async function getCount(ctx: Ctx, id: string) {
  const c = await db.stockCount.findFirst({
    where: { id, companyId: ctx.companyId },
    include: {
      warehouse: { select: { id: true, code: true, name: true } }, bin: { select: { code: true } }, creator: { select: { id: true, name: true } },
      lines: {
        orderBy: { lineNo: "asc" },
        include: { variant: { select: { sku: true, product: { select: { name: true, isSerialized: true } } } }, batch: { select: { batchNo: true } }, bin: { select: { code: true } } },
      },
    },
  });
  if (!c) throw new AppError("not_found", "Count not found");
  await requirePermission(ctx, "inventory.view", { warehouseId: c.warehouseId });
  const [approvals, movements, value, balances, settings] = await Promise.all([
    db.approval.findMany({ where: { companyId: ctx.companyId, entityType: "stock_count", entityId: c.id }, orderBy: { createdAt: "asc" }, include: { actor: { select: { name: true } } } }),
    db.inventoryMovement.findMany({ where: { companyId: ctx.companyId, sourceType: "stock_count", sourceId: c.id }, orderBy: { id: "asc" }, include: { bin: { select: { code: true } } } }),
    countValue(db, c),
    db.stockBalance.findMany({ where: { warehouseId: c.warehouseId, binId: { in: c.lines.map((l) => l.binId) }, variantId: { in: c.lines.map((l) => l.variantId) } } }),
    readSettings(db, ctx.companyId),
  ]);
  const lines = c.lines.map((l) => {
    const current = dec(balances.find((b) => b.binId === l.binId && b.variantId === l.variantId && b.batchId === l.batchId)?.onHand);
    const counted = l.countedQty != null;
    const variance = l.variance ?? (counted ? varianceOf(l) : null);
    return {
      ...l, current: current.toString(), variance: variance?.toString() ?? null, large: counted && isLarge(l, settings.countRecountPct),
      afterApply: counted && l.variance == null ? current.plus(varianceOf(l)).toString() : null,
    };
  });
  return { ...c, lines, approvals, movements, value, recountPct: settings.countRecountPct };
}
