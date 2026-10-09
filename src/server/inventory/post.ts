import { Prisma, type InventoryMovement, type MovementType } from "@/generated/prisma/client";
import { writeAudit } from "@/server/core/audit";
import type { Ctx } from "@/server/core/ctx";
import { AppError } from "@/server/core/errors";
import type { Tx } from "@/server/db";

// THE ledger writer (doc 07/08). Every stock change in the system goes through
// postMovements(): lock → validate invariants → update balances → append
// movements → audit, all inside the caller's transaction.

// High-precision Decimal for value math (q × cost can exceed the default 20 digits).
export const Dec = Prisma.Decimal.clone({ precision: 40, rounding: Prisma.Decimal.ROUND_HALF_UP });
export type Dec = InstanceType<typeof Dec>;
export type DecValue = string | number | { toString(): string };
export const dec = (v: DecValue | null | undefined) => new Dec(v == null ? 0 : v.toString());
const ZERO = dec(0);

export type Bucket = "onHand" | "blocked" | "damaged" | "expired" | "reserved";
const PHYSICAL = ["onHand", "blocked", "damaged", "expired"] as const;

type Kind = "in" | "out" | "internal" | "reserve" | "variance";
// Allowed sign per bucket (doc 08 §3). in/out change valued stock; internal moves
// between buckets/bins at unchanged value; reserve touches only qty_reserved; variance
// (transfer_variance) moves no bucket and books an in-transit loss (doc 11 §5).
const SHAPES: Partial<Record<MovementType, { kind: Kind; signs: Partial<Record<Bucket, 1 | -1>>; move?: true }>> = {
  opening_balance: { kind: "in", signs: { onHand: 1 } },
  purchase_receipt: { kind: "in", signs: { onHand: 1, damaged: 1, expired: 1 } },
  sale_return_quarantine: { kind: "in", signs: { blocked: 1 } },
  transfer_in: { kind: "in", signs: { onHand: 1, damaged: 1 } },
  adjustment_in: { kind: "in", signs: { onHand: 1 } },
  blocked_in: { kind: "in", signs: { blocked: 1 } },
  sale_fulfilment: { kind: "out", signs: { onHand: -1, reserved: -1 } },
  // Rejected/excess/damaged units go back too (doc 13 §5 PR-04), not only sellable ones.
  purchase_return: { kind: "out", signs: { onHand: -1, blocked: -1, damaged: -1, expired: -1 } },
  transfer_out: { kind: "out", signs: { onHand: -1 } },
  adjustment_out: { kind: "out", signs: { onHand: -1 } },
  disposal: { kind: "out", signs: { damaged: -1, expired: -1, blocked: -1 } },
  sale_return_restock: { kind: "internal", signs: { blocked: -1, onHand: 1 }, move: true },
  damage: { kind: "internal", signs: { onHand: -1, damaged: 1 }, move: true },
  repair_to_stock: { kind: "internal", signs: { damaged: -1, onHand: 1 }, move: true },
  expiry: { kind: "internal", signs: { onHand: -1, expired: 1 }, move: true },
  blocked_release: { kind: "internal", signs: { blocked: -1, onHand: 1 }, move: true },
  blocked_reject: { kind: "internal", signs: { blocked: -1, damaged: 1, expired: 1 }, move: true },
  putaway_out: { kind: "internal", signs: { onHand: -1 } },
  putaway_in: { kind: "internal", signs: { onHand: 1 } },
  reservation: { kind: "reserve", signs: { reserved: 1 } },
  reservation_release: { kind: "reserve", signs: { reserved: -1 } },
  transfer_variance: { kind: "variance", signs: {} },
  // ponytail: cost_correction needs cost-layer rules first; rejected until then.
};

// Inbound types whose unit cost defaults to the current WAC when not given.
const COST_DEFAULTS_TO_WAC: MovementType[] = ["adjustment_in", "blocked_in"];

export type Leg = {
  type: MovementType;
  variantId: string;
  warehouseId: string;
  binId?: string | null; // required for physical legs, forbidden for reservation legs
  batchId?: string | null;
  delta: Partial<Record<Bucket, DecValue>>;
  unitCost?: DecValue; // inbound legs; outbound/internal snapshot WAC
  value?: DecValue; // in / variance legs: exact value ≥ 0 instead of qty × unitCost (transfer settlement)
  line: number | string; // with `leg`, forms the derived key {source_type}:{source_id}:{line}:{leg}
  leg?: number;
  reasonCode: string;
  note?: string;
  reversesMovementId?: string; // mirror of that movement: same type/position, negated deltas (RC-08)
  serialized?: true; // caller keeps serial_unit in step in the same transaction (I-06)
  linkedReceiptId?: string; // purchase_return: relieved at `unitCost` = that receipt's cost (INV-022)
  linkedFulfilmentRef?: string; // sale_return_quarantine: the fulfilment movement returned against
  lotId?: string; // −blocked legs: consume exactly this quarantine lot (else FIFO at the bin row)
};

// postedAt: backdated created_at — opening_balance legs only (MV-04; a DB trigger backs it up).
export type PostInput = {
  sourceType: string; sourceId: string; legs: Leg[]; action?: string; postedAt?: Date;
  // T10.2 hot path (reserve): the caller already ran checkRefs() on these legs and
  // lockPositions() on their positions in this transaction, and has posted nothing since,
  // so they aren't re-validated / re-locked while the position lock is held. Reservation legs only.
  prelocked?: Map<string, PosState>;
};

export type PostResult = {
  movements: InventoryMovement[];
  auditId: string;
  replayed: boolean; // true when every leg already existed (double-post → no effect)
};

const posKey = (v: string, w: string, b: string | null) => `${v}|${w}|${b ?? ""}`;
const binKey = (v: string, w: string, bin: string, b: string | null) => `${v}|${w}|${bin}|${b ?? ""}`;
const costKey = (v: string, w: string) => `${v}|${w}`;
export const legKey = (sourceType: string, sourceId: string, l: Pick<Leg, "line" | "leg">) =>
  `${sourceType}:${sourceId}:${l.line}:${l.leg ?? 1}`;

type Norm = Leg & { batchId: string | null; binId: string | null; d: Record<Bucket, Dec>; key: string };

export async function postMovements(tx: Tx, ctx: Ctx, input: PostInput): Promise<PostResult> {
  if (input.legs.length === 0) throw new AppError("validation_error", "No movement legs (MV-01)");
  const legs = input.legs.map((l) => normalize(ctx, input, l));
  if (input.postedAt && (input.postedAt > new Date() || legs.some((l) => l.type !== "opening_balance"))) {
    throw new AppError("validation_error", "Only opening balances may be backdated, never into the future (MV-04)");
  }
  if (new Set(legs.map((l) => l.key)).size !== legs.length) {
    throw new AppError("validation_error", "Duplicate leg key within one posting");
  }
  const pre = input.prelocked;
  if (pre && !legs.every((l) => SHAPES[l.type]!.kind === "reserve" && pre.has(posKey(l.variantId, l.warehouseId, l.batchId)))) {
    throw new AppError("conflict", "A prelocked posting carries only reservation legs on locked positions");
  }
  if (!pre) await validateRefs(tx, ctx, legs);
  await checkReversals(tx, ctx, legs);
  assertPutawayPairs(legs);

  // 1. Locks: allocation rows (position), then bin rows ordered by bin_id, then cost rows.
  const positions = uniq(legs.map((l) => [l.variantId, l.warehouseId, l.batchId] as const), (p) => posKey(...p));
  const pos = pre ?? (await lockPositions(tx, ctx, positions));
  const physical = legs.filter((l) => l.binId);
  const bins = await lockBins(tx, ctx, uniq(physical.map((l) => [l.variantId, l.warehouseId, l.binId!, l.batchId] as const), (b) => binKey(...b)));
  const costs = await lockCosts(tx, ctx, uniq(physical.map((l) => [l.variantId, l.warehouseId] as const), (c) => costKey(...c)));

  // 2. Leg-level idempotency (MV-02), checked under the locks so a racing
  //    double-post sees the winner's committed legs.
  const existing = await tx.inventoryMovement.findMany({
    where: { companyId: ctx.companyId, idempotencyKey: { in: legs.map((l) => l.key) } },
    orderBy: { id: "asc" },
  });
  if (existing.length === legs.length) {
    const audit = await writeAudit(tx, ctx, {
      action: "dedup", entityType: input.sourceType, entityId: input.sourceId,
      after: { movementIds: existing.map((m) => m.id) },
    });
    return { movements: existing, auditId: audit.id, replayed: true };
  }
  if (existing.length > 0) {
    throw new AppError("duplicate", "Some legs of this posting already exist", { keys: existing.map((m) => m.idempotencyKey) });
  }

  // 3. Apply in memory, enforcing I-01/02/03/07.
  const rows: Prisma.InventoryMovementCreateManyInput[] = [];
  const reservedUp = new Set<string>();
  for (const l of legs) {
    const shape = SHAPES[l.type]!;
    const p = pos.get(posKey(l.variantId, l.warehouseId, l.batchId))!;
    const b = l.binId ? bins.get(binKey(l.variantId, l.warehouseId, l.binId, l.batchId))! : null;
    const c = l.binId ? costs.get(costKey(l.variantId, l.warehouseId))! : null;

    if (b) {
      for (const k of PHYSICAL) {
        b[k] = b[k].plus(l.d[k]);
        if (b[k].lt(0)) {
          throw new AppError("insufficient_stock", `Not enough ${k} in bin`, {
            variantId: l.variantId, warehouseId: l.warehouseId, binId: l.binId, batchId: l.batchId,
            bucket: k, available: b[k].minus(l.d[k]).toString(), requested: l.d[k].neg().toString(),
          });
        }
      }
      b.touched = true;
    }
    p.onHand = p.onHand.plus(l.d.onHand);
    p.reserved = p.reserved.plus(l.d.reserved);
    if (p.reserved.lt(0)) throw new AppError("conflict", "Release exceeds reserved quantity", { positionId: p.id });
    if (l.d.reserved.gt(0)) reservedUp.add(p.key);
    if (!l.d.reserved.isZero()) p.touched = true;

    // Valuation (doc 15): moving average over all physical buckets of (variant, warehouse).
    let unitCost: Dec | null = null;
    let valueDelta = ZERO;
    if (c) {
      const qty = PHYSICAL.reduce((s, k) => s.plus(l.d[k]), ZERO);
      const wac = c.qty.isZero() ? ZERO : c.value.div(c.qty).toDecimalPlaces(4);
      if (l.reversesMovementId && shape.kind !== "internal") {
        // RC-08: undo at the original cost; value never below 0, last units out take the rest.
        unitCost = dec(l.unitCost!);
        valueDelta = c.qty.plus(qty).isZero() ? c.value.neg() : Dec.max(qty.times(unitCost).toDecimalPlaces(4), c.value.neg());
      } else if (l.reversesMovementId) {
        unitCost = wac;
      } else if (shape.kind === "in") {
        unitCost = l.unitCost != null ? dec(l.unitCost) : COST_DEFAULTS_TO_WAC.includes(l.type) ? wac : null;
        if (unitCost == null || unitCost.lt(0)) throw new AppError("validation_error", `${l.type} needs a unit cost ≥ 0`);
        valueDelta = l.value != null ? dec(l.value) : qty.times(unitCost).toDecimalPlaces(4);
        if (valueDelta.lt(0)) throw new AppError("validation_error", "Leg value must be ≥ 0");
      } else if (shape.kind === "out" && l.linkedReceiptId) {
        // INV-022: relieve the linked receipt's cost, never more than the value left.
        unitCost = dec(l.unitCost!);
        valueDelta = c.qty.plus(qty).isZero() ? c.value.neg() : Dec.max(qty.times(unitCost).toDecimalPlaces(4), c.value.neg());
      } else if (shape.kind === "out") {
        unitCost = wac;
        // Last units out take the remaining value exactly, so value hits 0 with qty.
        valueDelta = qty.neg().eq(c.qty) ? c.value.neg() : qty.times(c.value).div(c.qty).toDecimalPlaces(4);
      } else {
        unitCost = wac;
      }
      c.qty = c.qty.plus(qty);
      c.value = c.value.plus(valueDelta);
      c.touched = true;
    } else if (shape.kind === "variance") {
      // No cost row: in-transit units belong to no warehouse's stock value; only the loss is booked.
      unitCost = dec(l.unitCost ?? 0);
      valueDelta = dec(l.value).neg();
    }

    rows.push({
      companyId: ctx.companyId, variantId: l.variantId, warehouseId: l.warehouseId,
      binId: l.binId, batchId: l.batchId, type: l.type,
      dOnHand: s(l.d.onHand), dBlocked: s(l.d.blocked), dDamaged: s(l.d.damaged),
      dExpired: s(l.d.expired), dReserved: s(l.d.reserved),
      onHandAfter: b ? s(b.onHand) : null, blockedAfter: b ? s(b.blocked) : null,
      damagedAfter: b ? s(b.damaged) : null, expiredAfter: b ? s(b.expired) : null,
      reservedAfter: s(p.reserved),
      unitCost: unitCost ? s(unitCost) : null, valueDelta: s(valueDelta),
      sourceType: input.sourceType, sourceId: input.sourceId,
      reversesMovementId: l.reversesMovementId ?? null, reasonCode: l.reasonCode, note: l.note ?? null,
      linkedReceiptId: l.linkedReceiptId ?? null, linkedFulfilmentRef: l.linkedFulfilmentRef ?? null,
      actorId: ctx.userId, channel: ctx.channel ?? null, idempotencyKey: l.key,
      ...(input.postedAt ? { createdAt: input.postedAt } : {}),
    });
  }

  // I-01/I-02/I-07 per position: reserved ≤ SUM(on_hand over its bins).
  for (const p of pos.values()) {
    if (p.reserved.gt(p.onHand)) {
      const details = {
        variantId: p.variantId, warehouseId: p.warehouseId, batchId: p.batchId,
        available: p.startOnHand.minus(p.startReserved).toString(),
      };
      if (reservedUp.has(p.key)) throw new AppError("insufficient_stock", "Not enough available stock", details);
      throw new AppError("reserved_conflict", "Operation would take reserved stock; release reservations first", details);
    }
  }

  // 4. Persist: balances, allocations, cost, movements, audit — one transaction.
  for (const b of bins.values()) {
    if (!b.touched) continue;
    await tx.stockBalance.update({
      where: { id: b.id },
      data: { onHand: s(b.onHand), blocked: s(b.blocked), damaged: s(b.damaged), expired: s(b.expired) },
    });
  }
  for (const p of pos.values()) {
    if (!p.touched) continue;
    await tx.stockAllocation.update({ where: { id: p.id }, data: { qtyReserved: s(p.reserved), version: { increment: 1 } } });
  }
  for (const c of costs.values()) {
    if (!c.touched) continue;
    await tx.variantCost.update({
      where: { variantId_warehouseId: { variantId: c.variantId, warehouseId: c.warehouseId } },
      data: { qty: s(c.qty), value: s(c.value) },
    });
  }
  let movements: InventoryMovement[];
  try {
    movements = await tx.inventoryMovement.createManyAndReturn({ data: rows });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new AppError("duplicate", "Movement leg already posted");
    }
    throw e;
  }
  await syncLots(tx, ctx, input, legs, movements);
  const audit = await writeAudit(tx, ctx, {
    action: input.action ?? "post",
    entityType: input.sourceType,
    entityId: input.sourceId,
    warehouseId: legs[0].warehouseId,
    after: {
      movementIds: movements.map((m) => m.id),
      balances: [...bins.values()].filter((b) => b.touched).map((b) => ({ ...b, touched: undefined })),
      allocations: [...pos.values()].filter((p) => p.touched).map((p) => ({ id: p.id, qtyReserved: p.reserved })),
    },
  });
  return { movements, auditId: audit.id, replayed: false };
}

const s = (d: Dec) => d.toFixed(4);

// Quarantine lots (doc 25 Inspection): +blocked opens a lot, −blocked consumes lots of
// the same bin row — the named lot, else the lot this leg reverses, else oldest first.
// Runs under the bin row locks taken above, so lots can't drift from stock_balance.blocked.
async function syncLots(tx: Tx, ctx: Ctx, input: PostInput, legs: Norm[], movements: InventoryMovement[]) {
  const byKey = new Map(movements.map((m) => [m.idempotencyKey, m]));
  for (const l of legs) {
    const m = byKey.get(l.key)!;
    if (l.d.blocked.gt(0)) {
      await tx.quarantineLot.create({
        data: {
          companyId: ctx.companyId, variantId: l.variantId, warehouseId: l.warehouseId, binId: l.binId!, batchId: l.batchId,
          reason: l.reasonCode, sourceType: input.sourceType, sourceId: input.sourceId, sourceLine: String(l.line),
          movementId: m.id, unitCost: m.unitCost, qty: s(l.d.blocked), qtyOpen: s(l.d.blocked), createdBy: ctx.userId,
        },
      });
    } else if (l.d.blocked.lt(0)) {
      const lots = await tx.$queryRaw<{ id: string; qty_open: unknown }[]>`
        SELECT q.id, q.qty_open FROM quarantine_lot q
        WHERE q.company_id = ${ctx.companyId} AND q.variant_id = ${l.variantId} AND q.warehouse_id = ${l.warehouseId}
          AND q.bin_id = ${l.binId} AND q.batch_id IS NOT DISTINCT FROM ${l.batchId} AND q.qty_open > 0
          AND (${l.lotId ?? null}::text IS NULL OR q.id = ${l.lotId ?? null})
        ORDER BY (q.movement_id IS NOT DISTINCT FROM ${l.reversesMovementId ?? null}) DESC, q.created_at, q.id
        FOR UPDATE OF q`;
      let left = l.d.blocked.neg();
      for (const lot of lots) {
        if (!left.gt(0)) break;
        const take = Dec.min(dec(lot.qty_open as string), left);
        await tx.quarantineLot.update({ where: { id: lot.id }, data: { qtyOpen: { decrement: s(take) } } });
        left = left.minus(take);
      }
      if (left.gt(0)) {
        throw new AppError(l.lotId ? "insufficient_stock" : "conflict", l.lotId ? "Not that much left open in this quarantine lot" : "Quarantine lots out of step with blocked stock", {
          lotId: l.lotId ?? null, binId: l.binId, requested: l.d.blocked.neg().toString(), missing: left.toString(),
        });
      }
    }
  }
}

// Putaway legs must net to zero per position inside one posting, so valued qty never
// dips between the two legs.
function assertPutawayPairs(legs: Norm[]) {
  const net = new Map<string, Dec>();
  for (const l of legs) {
    if (l.type !== "putaway_out" && l.type !== "putaway_in") continue;
    const k = posKey(l.variantId, l.warehouseId, l.batchId);
    net.set(k, (net.get(k) ?? ZERO).plus(l.d.onHand));
  }
  if ([...net.values()].some((n) => !n.isZero())) throw new AppError("validation_error", "Putaway legs must net to zero");
}

function uniq<T>(xs: T[], key: (x: T) => string): T[] {
  const m = new Map<string, T>();
  for (const x of xs) m.set(key(x), x);
  return [...m.values()];
}

function normalize(ctx: Ctx, input: PostInput, l: Leg): Norm {
  const shape = SHAPES[l.type];
  if (!shape) throw new AppError("validation_error", `Movement type ${l.type} is not supported yet`);
  if (ctx.warehouseIds !== "all" && !ctx.warehouseIds.includes(l.warehouseId)) {
    throw new AppError("forbidden", "Warehouse out of scope", { warehouseId: l.warehouseId });
  }
  const d = {} as Record<Bucket, Dec>;
  for (const k of [...PHYSICAL, "reserved"] as Bucket[]) {
    d[k] = dec(l.delta[k]);
    if (d[k].decimalPlaces() > 4) throw new AppError("validation_error", "Quantities allow at most 4 decimals");
    const sign = d[k].isZero() ? 0 : d[k].gt(0) ? 1 : -1;
    if (sign !== 0 && (shape.signs[k] ?? 0) * (l.reversesMovementId ? -1 : 1) !== sign) {
      throw new AppError("validation_error", `${l.type} cannot change ${k} by ${d[k].toString()}`);
    }
  }
  if (shape.kind === "variance") {
    if (l.binId || l.value == null || dec(l.value).lt(0)) throw new AppError("validation_error", "transfer_variance carries a value ≥ 0 and no bin");
    return { ...l, d, binId: null, batchId: l.batchId ?? null, key: legKey(input.sourceType, input.sourceId, l) };
  }
  if (Object.values(d).every((x) => x.isZero())) throw new AppError("validation_error", "Zero-quantity leg");
  if (!!l.linkedReceiptId !== (l.type === "purchase_return") || (l.linkedReceiptId && (l.unitCost == null || dec(l.unitCost).lt(0)))) {
    throw new AppError("validation_error", "A purchase return names its linked receipt and that receipt's unit cost (INV-022)");
  }
  if (l.linkedFulfilmentRef && l.type !== "sale_return_quarantine") throw new AppError("validation_error", "Only a sales return links a fulfilment");
  if (shape.move && !PHYSICAL.reduce((t, k) => t.plus(d[k]), ZERO).isZero()) {
    throw new AppError("validation_error", `${l.type} must move equal quantities between buckets`);
  }
  if (l.type === "sale_fulfilment" && !d.onHand.eq(d.reserved)) {
    throw new AppError("validation_error", "Fulfilment must reduce on_hand and reserved equally");
  }
  const isReserve = shape.kind === "reserve";
  if (isReserve && l.binId) throw new AppError("validation_error", "Reservation legs never pin a bin");
  if (!isReserve && !l.binId) throw new AppError("validation_error", `${l.type} needs a bin`);
  return {
    ...l, d, binId: l.binId ?? null, batchId: l.batchId ?? null,
    key: legKey(input.sourceType, input.sourceId, l),
  };
}

// Every referenced row must belong to ctx.companyId; bins to their warehouse;
// batches to their variant; batch present iff the product is batch-tracked.
type RefLeg = Pick<Norm, "variantId" | "warehouseId" | "binId" | "batchId" | "serialized">;
// Exported for reserve, which checks refs before it takes the position lock (PostInput.prelocked).
export const checkRefs = (tx: Tx, ctx: Ctx, legs: RefLeg[]) => validateRefs(tx, ctx, legs);

async function validateRefs(tx: Tx, ctx: Ctx, legs: RefLeg[]) {
  const companyId = ctx.companyId;
  const ids = (f: (l: RefLeg) => string | null) => [...new Set(legs.map(f).filter((x): x is string => !!x))];
  const binIds = ids((l) => l.binId), batchIds = ids((l) => l.batchId);
  // Share locks pair with the FOR UPDATE an archive takes (WH-02/03): an archive waits
  // for in-flight postings, and a posting after it sees `archived` and is rejected.
  await tx.$executeRaw`SELECT 1 FROM warehouse WHERE id = ANY(${ids((l) => l.warehouseId)}::text[]) ORDER BY id FOR SHARE`;
  if (binIds.length) await tx.$executeRaw`SELECT 1 FROM bin WHERE id = ANY(${binIds}::text[]) ORDER BY id FOR SHARE`;
  const [variants, warehouses, bins, batches] = await Promise.all([
    tx.productVariant.findMany({ where: { companyId, id: { in: ids((l) => l.variantId) } }, include: { product: true } }),
    tx.warehouse.findMany({ where: { companyId, id: { in: ids((l) => l.warehouseId) } } }),
    binIds.length ? tx.bin.findMany({ where: { companyId, id: { in: binIds } } }) : [],
    batchIds.length ? tx.batch.findMany({ where: { companyId, id: { in: batchIds } } }) : [],
  ]);
  const V = new Map(variants.map((v) => [v.id, v]));
  const W = new Map(warehouses.map((w) => [w.id, w]));
  const B = new Map(bins.map((b) => [b.id, b]));
  const T = new Map(batches.map((b) => [b.id, b]));
  for (const l of legs) {
    const v = V.get(l.variantId);
    if (!v || !W.has(l.warehouseId)) throw new AppError("not_found", "Variant or warehouse not found");
    if (l.binId && B.get(l.binId)?.warehouseId !== l.warehouseId) throw new AppError("not_found", "Bin not found in warehouse");
    if (W.get(l.warehouseId)!.status === "archived" || (l.binId && B.get(l.binId)!.archived)) {
      throw new AppError("archived_conflict", "Warehouse or bin is archived", { warehouseId: l.warehouseId, binId: l.binId });
    }
    if (l.batchId && T.get(l.batchId)?.variantId !== l.variantId) throw new AppError("not_found", "Batch not found for variant");
    if (v.product.requiresBatch !== !!l.batchId) {
      throw new AppError("validation_error", v.product.requiresBatch ? "Batch required for this product" : "Product is not batch-tracked");
    }
    // Only callers that keep serial_unit in step (receipts, reserve/fulfil, transfers,
    // damage/repair/disposal, returns, inspection) may move serialized stock; counts → Part 8.
    // Reservation legs touch no unit (units are named at fulfil, S-02).
    if (v.product.isSerialized && l.binId && !l.serialized) throw new AppError("validation_error", "Serialized products need serial capture for this operation (not supported yet)");
  }
}

// RC-08: a reversal leg mirrors its original exactly (same type and position, negated
// deltas) and takes the original unit cost. "Reversed at most once" is a DB index.
async function checkReversals(tx: Tx, ctx: Ctx, legs: Norm[]) {
  const ids = legs.map((l) => l.reversesMovementId).filter((x): x is string => !!x);
  if (!ids.length) return;
  const originals = new Map((await tx.inventoryMovement.findMany({ where: { companyId: ctx.companyId, id: { in: ids } } })).map((m) => [m.id, m]));
  for (const l of legs) {
    if (!l.reversesMovementId) continue;
    const o = originals.get(l.reversesMovementId);
    const mirrored = o && o.type === l.type && o.variantId === l.variantId && o.warehouseId === l.warehouseId
      && o.binId === l.binId && o.batchId === l.batchId
      && dec(o.dOnHand).neg().eq(l.d.onHand) && dec(o.dBlocked).neg().eq(l.d.blocked) && dec(o.dDamaged).neg().eq(l.d.damaged)
      && dec(o.dExpired).neg().eq(l.d.expired) && dec(o.dReserved).neg().eq(l.d.reserved);
    if (!mirrored) throw new AppError("validation_error", "A reversal must mirror its original movement", { movementId: l.reversesMovementId });
    l.unitCost = o.unitCost ?? 0;
  }
}

type PosState = {
  key: string; id: string; variantId: string; warehouseId: string; batchId: string | null;
  reserved: Dec; onHand: Dec; startReserved: Dec; startOnHand: Dec; touched?: boolean;
};

// Locks the allocation rows of the given positions (creating missing ones) in a
// stable order, and loads SUM(on_hand) over all bins of each position. Exported
// for reserve/fulfil, which must read ATP under the same lock before deciding.
export async function lockPositions(
  tx: Tx, ctx: Ctx, all: (readonly [string, string, string | null])[],
): Promise<Map<string, PosState>> {
  const positions = uniq(all, (p) => posKey(...p)); // documents may repeat a position across lines
  const vs = positions.map((p) => p[0]), ws = positions.map((p) => p[1]), bs = positions.map((p) => p[2]);
  await tx.$executeRaw`
    INSERT INTO stock_allocation (id, company_id, variant_id, warehouse_id, batch_id, updated_at)
    SELECT uuidv7()::text, ${ctx.companyId}, t.v, t.w, t.b, now()
    FROM unnest(${vs}::text[], ${ws}::text[], ${bs}::text[]) AS t(v, w, b)
    ORDER BY t.v, t.w, t.b NULLS FIRST
    ON CONFLICT (variant_id, warehouse_id, batch_id) DO NOTHING`;
  const rows = await tx.$queryRaw<{ id: string; variant_id: string; warehouse_id: string; batch_id: string | null; qty_reserved: unknown }[]>`
    SELECT a.id, a.variant_id, a.warehouse_id, a.batch_id, a.qty_reserved
    FROM stock_allocation a
    JOIN unnest(${vs}::text[], ${ws}::text[], ${bs}::text[]) AS t(v, w, b)
      ON a.variant_id = t.v AND a.warehouse_id = t.w AND a.batch_id IS NOT DISTINCT FROM t.b
    WHERE a.company_id = ${ctx.companyId}
    ORDER BY a.variant_id, a.warehouse_id, a.batch_id NULLS FIRST
    FOR UPDATE OF a`;
  const sums = await tx.$queryRaw<{ variant_id: string; warehouse_id: string; batch_id: string | null; on_hand: unknown }[]>`
    SELECT s.variant_id, s.warehouse_id, s.batch_id, SUM(s.on_hand) AS on_hand
    FROM stock_balance s
    JOIN unnest(${vs}::text[], ${ws}::text[], ${bs}::text[]) AS t(v, w, b)
      ON s.variant_id = t.v AND s.warehouse_id = t.w AND s.batch_id IS NOT DISTINCT FROM t.b
    GROUP BY s.variant_id, s.warehouse_id, s.batch_id`;
  const onHand = new Map(sums.map((r) => [posKey(r.variant_id, r.warehouse_id, r.batch_id), dec(r.on_hand as string)]));
  const out = new Map<string, PosState>();
  for (const r of rows) {
    const key = posKey(r.variant_id, r.warehouse_id, r.batch_id);
    const oh = onHand.get(key) ?? ZERO, res = dec(r.qty_reserved as string);
    out.set(key, {
      key, id: r.id, variantId: r.variant_id, warehouseId: r.warehouse_id, batchId: r.batch_id,
      reserved: res, onHand: oh, startReserved: res, startOnHand: oh,
    });
  }
  if (out.size !== positions.length) throw new AppError("not_found", "Stock position not found");
  return out;
}

// Which bins to take `qty` of `bucket` from (SO-05): the given bin, else default sellable
// first, then sellable, then by code. Call after lockPositions so no posting slips in;
// postMovements re-checks every bin under its own lock anyway.
export async function pickBins(
  tx: Tx,
  ctx: Ctx,
  p: { variantId: string; warehouseId: string; batchId: string | null; qty: Dec; bucket?: Exclude<Bucket, "reserved">; binId?: string | null },
): Promise<{ binId: string; qty: Dec }[]> {
  const bucket = p.bucket ?? "onHand";
  const rows = await tx.stockBalance.findMany({
    where: { companyId: ctx.companyId, variantId: p.variantId, warehouseId: p.warehouseId, batchId: p.batchId, binId: p.binId ?? undefined, [bucket]: { gt: 0 } },
    include: { bin: true },
  });
  rows.sort((a, b) =>
    Number(b.bin.isDefaultSellable) - Number(a.bin.isDefaultSellable) ||
    Number(b.bin.type === "sellable") - Number(a.bin.type === "sellable") ||
    a.bin.code.localeCompare(b.bin.code));
  const out: { binId: string; qty: Dec }[] = [];
  let left = p.qty;
  for (const r of rows) {
    if (!left.gt(0)) break;
    const take = Dec.min(dec(r[bucket]), left);
    out.push({ binId: r.binId, qty: take });
    left = left.minus(take);
  }
  if (left.gt(0)) {
    throw new AppError("insufficient_stock", `Not enough ${bucket} to take from`, {
      variantId: p.variantId, warehouseId: p.warehouseId, batchId: p.batchId, binId: p.binId ?? null,
      bucket, requested: p.qty.toString(), available: p.qty.minus(left).toString(),
    });
  }
  return out;
}

type BinState = {
  id: string; binId: string; batchId: string | null;
  onHand: Dec; blocked: Dec; damaged: Dec; expired: Dec; touched?: boolean;
};

async function lockBins(tx: Tx, ctx: Ctx, keys: (readonly [string, string, string, string | null])[]) {
  const out = new Map<string, BinState>();
  if (keys.length === 0) return out;
  const vs = keys.map((k) => k[0]), ws = keys.map((k) => k[1]), ns = keys.map((k) => k[2]), bs = keys.map((k) => k[3]);
  await tx.$executeRaw`
    INSERT INTO stock_balance (id, company_id, variant_id, warehouse_id, bin_id, batch_id, updated_at)
    SELECT uuidv7()::text, ${ctx.companyId}, t.v, t.w, t.n, t.b, now()
    FROM unnest(${vs}::text[], ${ws}::text[], ${ns}::text[], ${bs}::text[]) AS t(v, w, n, b)
    ORDER BY t.n, t.v, t.b NULLS FIRST
    ON CONFLICT (variant_id, warehouse_id, bin_id, batch_id) DO NOTHING`;
  const rows = await tx.$queryRaw<{ id: string; variant_id: string; warehouse_id: string; bin_id: string; batch_id: string | null; on_hand: unknown; blocked: unknown; damaged: unknown; expired: unknown }[]>`
    SELECT s.id, s.variant_id, s.warehouse_id, s.bin_id, s.batch_id, s.on_hand, s.blocked, s.damaged, s.expired
    FROM stock_balance s
    JOIN unnest(${vs}::text[], ${ws}::text[], ${ns}::text[], ${bs}::text[]) AS t(v, w, n, b)
      ON s.variant_id = t.v AND s.warehouse_id = t.w AND s.bin_id = t.n AND s.batch_id IS NOT DISTINCT FROM t.b
    WHERE s.company_id = ${ctx.companyId}
    ORDER BY s.bin_id, s.variant_id, s.batch_id NULLS FIRST
    FOR UPDATE OF s`;
  for (const r of rows) {
    out.set(binKey(r.variant_id, r.warehouse_id, r.bin_id, r.batch_id), {
      id: r.id, binId: r.bin_id, batchId: r.batch_id,
      onHand: dec(r.on_hand as string), blocked: dec(r.blocked as string),
      damaged: dec(r.damaged as string), expired: dec(r.expired as string),
    });
  }
  return out;
}

type CostState = { variantId: string; warehouseId: string; qty: Dec; value: Dec; touched?: boolean };

async function lockCosts(tx: Tx, ctx: Ctx, keys: (readonly [string, string])[]) {
  const out = new Map<string, CostState>();
  if (keys.length === 0) return out;
  const vs = keys.map((k) => k[0]), ws = keys.map((k) => k[1]);
  await tx.$executeRaw`
    INSERT INTO variant_cost (company_id, variant_id, warehouse_id, updated_at)
    SELECT ${ctx.companyId}, t.v, t.w, now() FROM unnest(${vs}::text[], ${ws}::text[]) AS t(v, w)
    ORDER BY t.v, t.w
    ON CONFLICT (variant_id, warehouse_id) DO NOTHING`;
  const rows = await tx.$queryRaw<{ variant_id: string; warehouse_id: string; qty: unknown; value: unknown }[]>`
    SELECT c.variant_id, c.warehouse_id, c.qty, c.value
    FROM variant_cost c
    JOIN unnest(${vs}::text[], ${ws}::text[]) AS t(v, w) ON c.variant_id = t.v AND c.warehouse_id = t.w
    WHERE c.company_id = ${ctx.companyId}
    ORDER BY c.variant_id, c.warehouse_id
    FOR UPDATE OF c`;
  for (const r of rows) {
    out.set(costKey(r.variant_id, r.warehouse_id), {
      variantId: r.variant_id, warehouseId: r.warehouse_id, qty: dec(r.qty as string), value: dec(r.value as string),
    });
  }
  return out;
}
