import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { buildCtx } from "@/server/auth/session-ctx";
import { createBatch, createProduct } from "@/server/catalog/catalog";
import type { Ctx } from "@/server/core/ctx";
import { db, transaction, type Tx } from "@/server/db";
import { createLoginUser, seedCompany } from "@/server/seed";
import { createWarehouse } from "@/server/warehouses/warehouses";
import { postMovements } from "./post";
import { fefoOrder, fulfil, reserve } from "./reservations";
import { fefoView, getSerialHistory, listSerials } from "./tracking";
import { approveTransfer, createTransfer, receiveTransfer, shipTransfer, submitTransfer } from "./transfers";

// T11.5: FEFO view ranks exactly as reserve picks; serial history from trigger events + movements; scope.

let w: Awaited<ReturnType<typeof seedCompany>>;
let mgr: Ctx;
let onlyA: Ctx; // scoped to warehouse A
let A: string, B: string;
let n = 0;
const tx = <T>(fn: (tx: Tx) => Promise<T>) => transaction(fn);
const days = (d: number) => new Date(Date.now() + d * 86_400_000);
const mainBin = async (wh: string) => (await db.bin.findFirstOrThrow({ where: { warehouseId: wh, code: "MAIN" } })).id;
const opening = async (t: Tx, variantId: string, wh: string, qty: number, batchId: string | null = null, serialized = false) =>
  postMovements(t, w.ctx, {
    sourceType: "opening", sourceId: `ob-${++n}`,
    legs: [{ type: "opening_balance", variantId, warehouseId: wh, binId: await mainBin(wh), batchId, delta: { onHand: qty }, unitCost: 5, line: 1, reasonCode: "opening", ...(serialized && { serialized: true as const }) }],
  });
async function newVariant(flags: { requiresBatch?: boolean; requiresExpiry?: boolean; isSerialized?: boolean }) {
  const p = await tx((t) => createProduct(t, w.ctx, { name: `Item ${crypto.randomUUID().slice(0, 8)}`, ...flags, variants: [{ sku: `SKU-${crypto.randomUUID().slice(0, 8)}` }] }));
  return p.variants[0];
}

beforeAll(async () => {
  w = await seedCompany(`trk-${crypto.randomUUID()}`);
  A = w.warehouse.id;
  B = (await tx((t) => createWarehouse(t, w.ctx, { code: "WH-B", name: "Branch" }))).id;
  w.ctx = await buildCtx(w.admin.id, { requestId: crypto.randomUUID(), channel: "system" });
  const roleId = w.roles.find((r) => r.code === "inventory_manager")!.id;
  const u = await tx((t) => createLoginUser(t, w.company.id, { name: "mgr", email: `mgr+${crypto.randomUUID()}@test.invalid`, password: "x", roleId }));
  mgr = await buildCtx(u.id, { requestId: crypto.randomUUID(), channel: "system" });
  onlyA = { ...w.ctx, warehouseIds: [A] };
});
afterAll(() => db.$disconnect());

describe("FEFO view (doc 14 §6)", () => {
  test("FEFO order, buckets, expiry status; pick ranks match the batches reserve pins", async () => {
    const v = await newVariant({ requiresBatch: true, requiresExpiry: true });
    const mk = (batchNo: string, expiryDate?: Date) => tx((t) => createBatch(t, w.ctx, { variantId: v.id, batchNo, expiryDate }));
    const late = await mk("L-LATE", days(120));
    const soon = await mk("L-SOON", days(10)); // inside the default 30-day alert horizon
    const none = await mk("L-NONE");
    const gone = await mk("L-GONE", days(-1));
    const tieB = await mk("L-TIE-B", days(60));
    const tieA = await mk("L-TIE-A", days(60));
    await tx(async (t) => {
      for (const b of [late, soon, none, gone, tieB, tieA]) await opening(t, v.id, A, 2, b.id);
      await opening(t, v.id, B, 1, late.id);
    });

    const view = await fefoView(w.ctx, { variantId: v.id, warehouseId: A });
    expect(view.rows.map((r) => [r.batchNo, r.status, r.pickRank])).toEqual([
      ["L-GONE", "expired", null], ["L-SOON", "expiring", 1], ["L-TIE-A", "ok", 2], ["L-TIE-B", "ok", 3], ["L-LATE", "ok", 4], ["L-NONE", "none", 5],
    ]);
    expect(view.rows.find((r) => r.batchNo === "L-GONE")!.available).toBe("0");
    expect(view.rows.every((r) => r.warehouseId === A)).toBe(true);
    // Same comparator as the engine.
    expect([...view.rows].sort(fefoOrder).map((r) => r.batchNo)).toEqual(view.rows.map((r) => r.batchNo));

    // The engine pins batches in exactly that rank order (expired skipped).
    const r = await tx((t) => reserve(t, w.ctx, { variantId: v.id, warehouseId: A, qty: 9 }));
    const pinned = r.reservation.lines.map((l) => view.rows.find((x) => x.batchId === l.batchId)!.batchNo);
    expect(pinned).toEqual(["L-SOON", "L-TIE-A", "L-TIE-B", "L-LATE", "L-NONE"]);
    const after = await fefoView(w.ctx, { variantId: v.id, warehouseId: A });
    expect(after.rows.find((x) => x.batchNo === "L-SOON")).toMatchObject({ reserved: "2", available: "0", onHand: "2" });

    // Both warehouses without a filter; scoped caller sees only A, and B is forbidden.
    expect(new Set((await fefoView(w.ctx, { variantId: v.id })).rows.map((x) => x.warehouseCode))).toEqual(new Set(["WH-MAIN-01", "WH-B"]));
    expect((await fefoView(onlyA, { variantId: v.id })).rows.every((x) => x.warehouseId === A)).toBe(true);
    await expect(fefoView(onlyA, { variantId: v.id, warehouseId: B })).rejects.toMatchObject({ code: "forbidden" });
  });

  test("other company's variant is not found", async () => {
    const other = await seedCompany(`trk-o-${crypto.randomUUID()}`);
    await expect(fefoView(w.ctx, { variantId: other.variants[0].id })).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("serial lifecycle (doc 14 §6)", () => {
  test("history: created → in transit → in stock at B → sold, each with its movements", async () => {
    const v = await newVariant({ isSerialized: true });
    const serialNo = `SN-${crypto.randomUUID().slice(0, 8)}`;
    await tx(async (t) => {
      await opening(t, v.id, A, 1, null, true);
      await t.serialUnit.create({ data: { companyId: w.company.id, variantId: v.id, serialNo, status: "in_stock", warehouseId: A, binId: await mainBin(A) } });
    });
    const t0 = await tx((t) => createTransfer(t, w.ctx, { fromWarehouseId: A, toWarehouseId: B, lines: [{ variantId: v.id, qty: 1 }] }));
    await tx((t) => submitTransfer(t, w.ctx, { id: t0.id, version: 0 }));
    await tx((t) => approveTransfer(t, mgr, { id: t0.id, version: 1 }));
    const line = (await db.transferLine.findFirstOrThrow({ where: { transferId: t0.id } })).id;
    const s = await tx((t) => shipTransfer(t, w.ctx, { id: t0.id, version: 2, lines: [{ lineId: line, serials: [serialNo] }] }));
    await tx((t) => receiveTransfer(t, w.ctx, { id: t0.id, version: s.version, lines: [{ lineId: line, received: 1, serials: [serialNo] }] }));
    const r = await tx((t) => reserve(t, w.ctx, { variantId: v.id, warehouseId: B, qty: 1 }));
    await tx((t) => fulfil(t, w.ctx, { reservationId: r.reservation.id, version: 0, serials: [serialNo] }));

    const unit = (await listSerials(w.ctx, { q: serialNo.toLowerCase(), page: 1, perPage: 10 })).items;
    expect(unit.map((u) => [u.serialNo, u.status, u.warehouse.code])).toEqual([[serialNo, "sold", "WH-B"]]);
    expect((await listSerials(w.ctx, { q: v.sku, page: 1, perPage: 10 })).total).toBe(1);

    const h = await getSerialHistory(w.ctx, unit[0].id);
    expect(h.events.map((e) => [e.fromStatus, e.toStatus, e.warehouseCode, e.movements.map((m) => m.type)])).toEqual([
      [null, "in_stock", "WH-MAIN-01", ["opening_balance"]],
      ["in_stock", "in_transit", "WH-MAIN-01", ["transfer_out"]],
      ["in_transit", "in_stock", "WH-B", ["transfer_in"]],
      ["in_stock", "sold", "WH-B", ["sale_fulfilment"]],
    ]);

    // Scope: the unit now sits in B — invisible to an A-only user, history forbidden.
    expect((await listSerials(onlyA, { q: serialNo, page: 1, perPage: 10 })).total).toBe(0);
    await expect(getSerialHistory(onlyA, unit[0].id)).rejects.toMatchObject({ code: "forbidden" });
    // A B-only user sees the whole status trail, but the A steps carry no warehouse/bin and no movements (doc 02 §3).
    const hb = await getSerialHistory({ ...w.ctx, warehouseIds: [B] }, unit[0].id);
    expect(hb.events.map((e) => [e.fromStatus, e.toStatus, e.warehouseId, e.warehouseCode, e.binId, e.binCode, e.movements.map((m) => m.type)])).toEqual([
      [null, "in_stock", null, null, null, null, []],
      ["in_stock", "in_transit", null, null, null, null, []],
      ["in_transit", "in_stock", B, "WH-B", expect.any(String), "RECV", ["transfer_in"]],
      ["in_stock", "sold", B, "WH-B", expect.any(String), "RECV", ["sale_fulfilment"]],
    ]);
    await expect(db.$executeRaw`DELETE FROM serial_unit_event WHERE serial_unit_id = ${unit[0].id}`).rejects.toThrow(/append-only/);
  });
});
