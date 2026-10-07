import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { buildCtx } from "@/server/auth/session-ctx";
import { createBatch, createProduct } from "@/server/catalog/catalog";
import type { Ctx } from "@/server/core/ctx";
import { execute } from "@/server/core/execute";
import { db, transaction, type Tx } from "@/server/db";
import { createLoginUser, seedCompany } from "@/server/seed";
import { createWarehouse, updateWarehouse } from "@/server/warehouses/warehouses";
import { postMovements } from "./post";
import { reconcile } from "./reconcile";
import { cancel, reserve } from "./reservations";
import {
  approveTransfer, cancelTransfer, createTransfer, decideVariance, receiveTransfer, rejectTransfer, shipTransfer, submitTransfer,
  type TransferLineInput,
} from "./transfers";
import { liveValue, valueAt } from "./valuation";

// Part 6 gate (P6): transfers — partial + damaged + missing in transit, over-receipt
// blocked, reserved_conflict on ship, double-approve, idempotent receive, SoD, serials.

let w: Awaited<ReturnType<typeof seedCompany>>;
let mgr: Ctx; // inventory_manager — approves what the admin creates (creator ≠ approver)
let A: string, B: string; // warehouses
let n = 0;
const tx = <T>(fn: (tx: Tx) => Promise<T>) => transaction(fn);

async function userCtx(role: string) {
  const roleId = w.roles.find((r) => r.code === role)!.id;
  const u = await tx((t) => createLoginUser(t, w.company.id, { name: role, email: `${role}+${crypto.randomUUID()}@test.invalid`, password: "x", roleId }));
  return buildCtx(u.id, { requestId: crypto.randomUUID(), channel: "system" });
}
const binOf = async (wh: string, code: string) => (await db.bin.findFirstOrThrow({ where: { warehouseId: wh, code } })).id;
async function stock(variantId: string, qty: number, unitCost = 10, batchId: string | null = null) {
  return tx((t) => postMovements(t, w.ctx, {
    sourceType: "opening", sourceId: `ob-${++n}`,
    legs: [{ type: "opening_balance", variantId, warehouseId: A, binId: w.warehouse.bins.find((b) => b.code === "MAIN")!.id, batchId, delta: { onHand: qty }, unitCost, line: 1, reasonCode: "opening" }],
  }));
}
async function newVariant(flags: { requiresBatch?: boolean; isSerialized?: boolean } = {}) {
  const p = await tx((t) => createProduct(t, w.ctx, { name: `Item ${crypto.randomUUID().slice(0, 8)}`, ...flags, variants: [{ sku: `SKU-${crypto.randomUUID().slice(0, 8)}` }] }));
  return p.variants[0];
}
// draft (admin) → submitted → approved (mgr)
async function approved(lines: TransferLineInput[]) {
  const t = await tx((x) => createTransfer(x, w.ctx, { fromWarehouseId: A, toWarehouseId: B, lines }));
  await tx((x) => submitTransfer(x, w.ctx, { id: t.id, version: 0 }));
  await tx((x) => approveTransfer(x, mgr, { id: t.id, version: 1 }));
  return db.transfer.findUniqueOrThrow({ where: { id: t.id }, include: { lines: { orderBy: { lineNo: "asc" } } } });
}
const sum = async (variantId: string, warehouseId: string) => {
  const r = await db.stockBalance.aggregate({ where: { variantId, warehouseId }, _sum: { onHand: true, damaged: true } });
  return { onHand: r._sum.onHand?.toString() ?? "0", damaged: r._sum.damaged?.toString() ?? "0" };
};
const cost = async (variantId: string, warehouseId: string) => {
  const c = await db.variantCost.findUnique({ where: { variantId_warehouseId: { variantId, warehouseId } } });
  return c ? [c.qty.toString(), c.value.toString()] : ["0", "0"];
};
async function clean() {
  expect(await reconcile(w.ctx)).toEqual([]);
  const [live, replay] = await Promise.all([liveValue(w.ctx), valueAt(w.ctx, new Date())]);
  expect(replay.total).toBe(live.total);
  expect(replay.inTransit).toBe(live.inTransit);
  return live;
}

beforeAll(async () => {
  w = await seedCompany(`tr-${crypto.randomUUID()}`);
  mgr = await userCtx("inventory_manager");
  A = w.warehouse.id;
  B = (await tx((t) => createWarehouse(t, w.ctx, { code: "WH-B", name: "Branch" }))).id;
  w.ctx = await buildCtx(w.admin.id, { requestId: crypto.randomUUID(), channel: "system" }); // sees WH-B too
});
afterAll(() => db.$disconnect());

describe("transfer lifecycle (doc 11, doc 23)", () => {
  test("TR-01: same warehouse, SoD, reject → draft with comment, cancel only before ship", async () => {
    const v = await newVariant();
    await expect(tx((x) => createTransfer(x, w.ctx, { fromWarehouseId: A, toWarehouseId: A, lines: [{ variantId: v.id, qty: 1 }] })))
      .rejects.toMatchObject({ code: "validation_error" });
    const t = await tx((x) => createTransfer(x, w.ctx, { fromWarehouseId: A, toWarehouseId: B, lines: [{ variantId: v.id, qty: 5 }] }));
    expect(t.number).toMatch(/^TR-\d{4}-\d{5}$/);
    expect(t.warnings).toEqual([expect.stringContaining("only 0 available")]); // TR-02 advisory
    await tx((x) => submitTransfer(x, w.ctx, { id: t.id, version: 0 }));
    await expect(tx((x) => approveTransfer(x, w.ctx, { id: t.id, version: 1 }))).rejects.toMatchObject({ code: "forbidden", details: { reason: "creator_is_approver" } });
    await expect(tx((x) => rejectTransfer(x, mgr, { id: t.id, version: 1, comment: " " }))).rejects.toMatchObject({ code: "validation_error" });
    await tx((x) => rejectTransfer(x, mgr, { id: t.id, version: 1, comment: "wrong qty" }));
    expect((await db.transfer.findUniqueOrThrow({ where: { id: t.id } })).status).toBe("draft");
    await tx((x) => submitTransfer(x, w.ctx, { id: t.id, version: 2 }));
    await tx((x) => approveTransfer(x, mgr, { id: t.id, version: 3 }));
    await tx((x) => cancelTransfer(x, w.ctx, { id: t.id, version: 4, reason: "not needed" }));
    expect((await db.approval.findMany({ where: { entityId: t.id }, orderBy: { createdAt: "asc" } })).map((a) => a.decision)).toEqual(["rejected", "approved"]);
  });

  test("ship → partial receive with damaged → receive rest: balances, WAC snapshot, in-transit value", async () => {
    const v = await newVariant();
    await stock(v.id, 10, 10);
    await stock(v.id, 10, 20); // WAC 15
    const t = await approved([{ variantId: v.id, qty: 12 }]);
    const shipped = await tx((x) => shipTransfer(x, w.ctx, { id: t.id, version: t.version }));
    expect(shipped.status).toBe("in_transit");
    expect(shipped.lines[0].shippedValue.toString()).toBe("180");
    expect(await sum(v.id, A)).toEqual({ onHand: "8", damaged: "0" });
    expect(await cost(v.id, A)).toEqual(["8", "120"]);
    expect((await clean()).inTransit).toBe("180");
    await expect(tx((x) => cancelTransfer(x, w.ctx, { id: t.id, version: shipped.version }))).rejects.toMatchObject({ code: "invalid_transition" }); // TR-05

    const r1 = await tx((x) => receiveTransfer(x, w.ctx, { id: t.id, version: shipped.version, lines: [{ lineId: t.lines[0].id, received: 5, damaged: 1 }] }));
    expect(r1.status).toBe("partially_received");
    expect(await sum(v.id, B)).toEqual({ onHand: "5", damaged: "1" });
    expect(await cost(v.id, B)).toEqual(["6", "90"]); // admitted at the 15 ship snapshot, not revalued
    expect((await clean()).inTransit).toBe("90");

    // TR-03: over-receipt blocked
    await expect(tx((x) => receiveTransfer(x, w.ctx, { id: t.id, version: r1.version, lines: [{ lineId: t.lines[0].id, received: 7 }] })))
      .rejects.toMatchObject({ code: "validation_error", details: { inTransit: "6" } });
    const r2 = await tx((x) => receiveTransfer(x, w.ctx, { id: t.id, version: r1.version, lines: [{ lineId: t.lines[0].id, received: 6 }] }));
    expect(r2.status).toBe("closed_with_variance"); // damaged in transit
    expect(await cost(v.id, B)).toEqual(["12", "180"]);
    expect((await clean()).inTransit).toBe("0");
  });

  test("missing in transit: report → approve → transfer_variance loss at ship snapshot; reject keeps it in transit", async () => {
    const v = await newVariant();
    await stock(v.id, 3, 10); // value 10/3 per unit: exercises the exact-remainder settlement
    await stock(v.id, 0.5, 0);
    const t = await approved([{ variantId: v.id, qty: 3 }]);
    const s = await tx((x) => shipTransfer(x, w.ctx, { id: t.id, version: t.version }));
    const line = t.lines[0].id;
    const r1 = await tx((x) => receiveTransfer(x, w.ctx, { id: t.id, version: s.version, lines: [{ lineId: line, received: 1, missing: 1 }] }));
    expect(r1.status).toBe("partially_received");
    // creator can't approve their own transfer's variance; a rejection needs a comment
    await expect(tx((x) => decideVariance(x, w.ctx, { id: t.id, version: r1.version, approve: true }))).rejects.toMatchObject({ code: "forbidden" });
    const rej = await tx((x) => decideVariance(x, mgr, { id: t.id, version: r1.version, approve: false, comment: "found on truck" }));
    expect((await db.transferLine.findUniqueOrThrow({ where: { id: line } })).qtyMissingReported.toString()).toBe("0");
    const r2 = await tx((x) => receiveTransfer(x, w.ctx, { id: t.id, version: rej.version, lines: [{ lineId: line, received: 1, missing: 1 }] }));
    const ok = await tx((x) => decideVariance(x, mgr, { id: t.id, version: r2.version, approve: true, comment: "carrier claim #7" }));
    expect(ok.status).toBe("closed_with_variance");
    const m = await db.inventoryMovement.findFirstOrThrow({ where: { type: "transfer_variance", sourceId: { startsWith: t.id } } });
    // shipped 3 @ WAC 30/3.5 = 25.7143; two receipts took 8.5714 each, the loss takes the exact rest
    expect([m.warehouseId, m.binId, m.dOnHand.toString(), m.valueDelta.toString()]).toEqual([A, null, "0", "-8.5715"]);
    const live = await clean();
    expect(live.inTransit).toBe("0");
    const l = await db.transferLine.findUniqueOrThrow({ where: { id: line } });
    expect([l.qtyReceived, l.qtyMissing, l.settledValue].map(String)).toEqual(["2", "1", l.shippedValue.toString()]);
  });

  test("ship enforces ATP and I-07: reserved units can't leave (reserved_conflict)", async () => {
    const v = await newVariant();
    await stock(v.id, 5);
    const t = await approved([{ variantId: v.id, qty: 4 }]);
    const r = await tx((x) => reserve(x, w.ctx, { variantId: v.id, warehouseId: A, qty: 2 }));
    await expect(tx((x) => shipTransfer(x, w.ctx, { id: t.id, version: t.version }))).rejects.toMatchObject({ code: "reserved_conflict" });
    await expect(tx((x) => shipTransfer(x, w.ctx, { id: t.id, version: t.version, lines: [{ lineId: t.lines[0].id, qty: 6 }] })))
      .rejects.toMatchObject({ code: "validation_error" }); // more than requested
    const s = await tx((x) => shipTransfer(x, w.ctx, { id: t.id, version: t.version, lines: [{ lineId: t.lines[0].id, qty: 3 }] }));
    expect(s.lines[0].qtyShipped.toString()).toBe("3");
    await tx((x) => cancel(x, w.ctx, { reservationId: r.reservation.id, version: 0 }));
    await clean();
  });

  test("edge #33: two approvers at once → one wins, the other gets version_conflict", async () => {
    const v = await newVariant();
    const t = await tx((x) => createTransfer(x, w.ctx, { fromWarehouseId: A, toWarehouseId: B, lines: [{ variantId: v.id, qty: 1 }] }));
    await tx((x) => submitTransfer(x, w.ctx, { id: t.id, version: 0 }));
    const other = await userCtx("owner");
    const results = await Promise.allSettled([mgr, other].map((c) =>
      execute(c, { scope: "transfers.approve", entity: { type: "transfer", id: t.id } }, (x) => approveTransfer(x, c, { id: t.id, version: 1 }))));
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ code: "version_conflict" });
    expect(await db.approval.count({ where: { entityId: t.id } })).toBe(1);
    expect(await db.auditLog.count({ where: { entityId: t.id, action: "transition.denied" } })).toBe(1);
  });

  test("edge #11: duplicate receive (same Idempotency-Key) replays, no double increment", async () => {
    const v = await newVariant();
    await stock(v.id, 4);
    const t = await approved([{ variantId: v.id, qty: 4 }]);
    const s = await tx((x) => shipTransfer(x, w.ctx, { id: t.id, version: t.version }));
    const body = { id: t.id, version: s.version, lines: [{ lineId: t.lines[0].id, received: 2 }] };
    const run = () => execute(w.ctx, { scope: "transfers.receive", idempotencyKey: `rcv-${t.id}`, request: body }, (x) => receiveTransfer(x, w.ctx, body));
    const [a, b] = [await run(), await run()];
    expect(b).toEqual(a);
    expect((await sum(v.id, B)).onHand).toBe("2");
    await clean();
  });

  test("TR-04: batch pinned on the line, serial units listed on ship and receive", async () => {
    const bv = await newVariant({ requiresBatch: true });
    const batch = await tx((x) => createBatch(x, w.ctx, { variantId: bv.id, batchNo: "L1", expiryDate: new Date(Date.now() + 90 * 86_400_000) }));
    await stock(bv.id, 5, 10, batch.id);
    await expect(tx((x) => createTransfer(x, w.ctx, { fromWarehouseId: A, toWarehouseId: B, lines: [{ variantId: bv.id, qty: 1 }] })))
      .rejects.toMatchObject({ code: "validation_error", details: { field: "batchId" } });
    const bt = await approved([{ variantId: bv.id, qty: 5, batchId: batch.id }]);
    const bs = await tx((x) => shipTransfer(x, w.ctx, { id: bt.id, version: bt.version }));
    await tx((x) => receiveTransfer(x, w.ctx, { id: bt.id, version: bs.version, lines: [{ lineId: bt.lines[0].id, received: 5 }] }));
    expect((await db.stockBalance.aggregate({ where: { variantId: bv.id, warehouseId: B, batchId: batch.id }, _sum: { onHand: true } }))._sum.onHand!.toString()).toBe("5");

    // Serialized: units come from a real receipt path (serial_unit rows), here created directly.
    const sv = await newVariant({ isSerialized: true });
    const main = await binOf(A, "MAIN");
    await tx(async (x) => {
      await postMovements(x, w.ctx, { sourceType: "opening", sourceId: `ob-${++n}`, legs: [{ type: "opening_balance", variantId: sv.id, warehouseId: A, binId: main, delta: { onHand: 3 }, unitCost: 100, line: 1, reasonCode: "opening", serialized: true }] });
      await x.serialUnit.createMany({ data: ["S1", "S2", "S3"].map((serialNo) => ({ companyId: w.company.id, variantId: sv.id, serialNo, status: "in_stock" as const, warehouseId: A, binId: main })) });
    });
    const st = await approved([{ variantId: sv.id, qty: 3 }]);
    await expect(tx((x) => shipTransfer(x, w.ctx, { id: st.id, version: st.version, lines: [{ lineId: st.lines[0].id, serials: ["S1", "S2"] }] })))
      .rejects.toMatchObject({ code: "validation_error", details: { field: "serials" } });
    const ss = await tx((x) => shipTransfer(x, w.ctx, { id: st.id, version: st.version, lines: [{ lineId: st.lines[0].id, serials: ["S1", "S2", "S3"] }] }));
    expect((await db.serialUnit.findMany({ where: { variantId: sv.id } })).map((u) => u.status)).toEqual(["in_transit", "in_transit", "in_transit"]);
    await expect(tx((x) => receiveTransfer(x, w.ctx, { id: st.id, version: ss.version, lines: [{ lineId: st.lines[0].id, received: 1, serials: ["S9"] }] })))
      .rejects.toMatchObject({ code: "validation_error" });
    const sr = await tx((x) => receiveTransfer(x, w.ctx, { id: st.id, version: ss.version, lines: [{ lineId: st.lines[0].id, received: 1, damaged: 1, serials: ["S1"], damagedSerials: ["S2"], missing: 1 }] }));
    await tx((x) => decideVariance(x, mgr, { id: st.id, version: sr.version, approve: true }));
    const units = Object.fromEntries((await db.serialUnit.findMany({ where: { variantId: sv.id } })).map((u) => [u.serialNo, `${u.status}@${u.warehouseId === B ? "B" : "A"}`]));
    expect(units).toEqual({ S1: "in_stock@B", S2: "damaged@B", S3: "lost@A" });
    await clean();
  });

  test("edge #25 / TR-07: warehouse with an open transfer can't be archived; archived destination blocks new transfers", async () => {
    const v = await newVariant();
    const t = await tx((x) => createTransfer(x, w.ctx, { fromWarehouseId: A, toWarehouseId: B, lines: [{ variantId: v.id, qty: 1 }] }));
    const wb = await db.warehouse.findUniqueOrThrow({ where: { id: B } });
    // B may hold stock from earlier tests; the open transfer must be listed as a blocker either way.
    await expect(tx((x) => updateWarehouse(x, w.ctx, { id: B, version: wb.version, status: "archived" })))
      .rejects.toMatchObject({ code: "conflict", details: { openTransfers: expect.any(Number) } });
    await tx((x) => cancelTransfer(x, w.ctx, { id: t.id, version: 0 }));
    const c = await tx((x) => createWarehouse(x, w.ctx, { code: `WH-${++n}`, name: "Empty" }));
    await tx((x) => updateWarehouse(x, w.ctx, { id: c.id, version: c.version, status: "archived" }));
    await expect(tx((x) => createTransfer(x, w.ctx, { fromWarehouseId: A, toWarehouseId: c.id, lines: [{ variantId: v.id, qty: 1 }] })))
      .rejects.toMatchObject({ code: "archived_conflict" });
  });
});

