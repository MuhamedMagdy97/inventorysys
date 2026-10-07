import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { decide, listInbox } from "@/server/approvals/inbox";
import { buildCtx } from "@/server/auth/session-ctx";
import { createProduct } from "@/server/catalog/catalog";
import type { Ctx } from "@/server/core/ctx";
import { db, transaction, type Tx } from "@/server/db";
import { createLoginUser, seedCompany } from "@/server/seed";
import { createBin, createWarehouse, updateBin, updateWarehouse } from "@/server/warehouses/warehouses";
import { approveAdjustment, createAdjustment, submitAdjustment } from "./adjustments";
import { applyCount, approveCount, cancelCount, enterCounts, getCount, openCount, recountCount, submitCount } from "./counts";
import { postMovements } from "./post";
import { reconcile } from "./reconcile";
import { cancel, reserve } from "./reservations";
import { valueAt } from "./valuation";

// Part 8 gate: flow 19 counts (INV-023 snapshot + variance under lock, recount loop,
// serialized found/loss, WH-02/03) and flow 26 opening balance (dual control, MV-04).

let w: Awaited<ReturnType<typeof seedCompany>>;
let staff: Ctx; // warehouse_staff: counts (count_submit) only
let mgr: Ctx; // inventory_manager: approve + apply
let main: string, recv: string;
let n = 0;
const tx = <T>(fn: (tx: Tx) => Promise<T>) => transaction(fn);

async function userCtx(role: string, warehouseIds: string[] = []) {
  const roleId = w.roles.find((r) => r.code === role)!.id;
  const u = await tx((t) => createLoginUser(t, w.company.id, { name: role, email: `${role}+${crypto.randomUUID()}@test.invalid`, password: "x", roleId, warehouseIds }));
  return buildCtx(u.id, { requestId: crypto.randomUUID(), channel: "system" });
}
async function newVariant(flags: { isSerialized?: boolean } = {}) {
  const p = await tx((t) => createProduct(t, w.ctx, { name: `Item ${crypto.randomUUID().slice(0, 8)}`, ...flags, variants: [{ sku: `SKU-${crypto.randomUUID().slice(0, 8)}` }] }));
  return p.variants[0];
}
// A posting by "someone else" while the count is running.
const bump = (variantId: string, qty: number, binId = main) =>
  tx((t) => postMovements(t, w.ctx, {
    sourceType: "test", sourceId: `t-${++n}`,
    legs: [{ type: qty > 0 ? "adjustment_in" : "adjustment_out", variantId, warehouseId: w.warehouse.id, binId, delta: { onHand: qty }, unitCost: 10, line: 1, reasonCode: "test" }],
  }));
const onHand = async (variantId: string, binId = main) =>
  (await db.stockBalance.findFirst({ where: { variantId, binId } }))?.onHand.toString() ?? "0";
const opening = async (lines: Parameters<typeof createAdjustment>[2]["lines"], asOf?: Date, warehouseId = w.warehouse.id) => {
  const a = await tx((t) => createAdjustment(t, w.ctx, { kind: "opening", warehouseId, reasonCode: "opening", asOf, lines }));
  await tx((t) => submitAdjustment(t, w.ctx, { id: a.id, version: 0 }));
  return a;
};
const ver = async (id: string) => (await db.stockCount.findUniqueOrThrow({ where: { id } })).version;
const lineOf = async (countId: string, variantId: string) => (await db.stockCountLine.findFirstOrThrow({ where: { countId, variantId } }));

beforeAll(async () => {
  w = await seedCompany(`cnt-${crypto.randomUUID()}`);
  [staff, mgr] = await Promise.all([userCtx("warehouse_staff", [w.warehouse.id]), userCtx("inventory_manager")]);
  main = w.warehouse.bins.find((b) => b.code === "MAIN")!.id;
  recv = w.warehouse.bins.find((b) => b.code === "RECV")!.id;
});
afterAll(async () => {
  expect(await reconcile(w.ctx)).toEqual([]);
  await db.$disconnect();
});

describe("stock count (flow 19, INV-023)", () => {
  test("concurrent postings: variance = counted − system at count time, applied to the current balance", async () => {
    const v = await newVariant();
    await bump(v.id, 10);
    const c = await tx((t) => openCount(t, w.ctx, { warehouseId: w.warehouse.id, variantIds: [v.id] }));
    expect(c.lines.map((l) => [l.binId, l.snapshotQty.toString()])).toEqual([[main, "10"]]);
    await bump(v.id, -2); // sold before the shelf was counted → system 8
    const line = c.lines[0];
    await tx((t) => enterCounts(t, staff, { id: c.id, entries: [{ lineId: line.id, countedQty: 7 }] }));
    expect((await lineOf(c.id, v.id)).systemQty?.toString()).toBe("8");
    await bump(v.id, 5); // received after counting → 13

    // −1 of 8 = 12.5% > 10% → forced recount, back to counting
    const s1 = await tx((t) => submitCount(t, staff, { id: c.id, version: 1 }));
    expect([s1.status, (s1 as { recountLineNos?: number[] }).recountLineNos]).toEqual(["counting", [1]]);
    await expect(tx((t) => submitCount(t, staff, { id: c.id, version: 2 }))).rejects.toMatchObject({ code: "validation_error" }); // recount pending
    await tx((t) => enterCounts(t, staff, { id: c.id, entries: [{ lineId: line.id, countedQty: 12 }] })); // recount after the receipt: 7 + 5 → still −1 vs system 13
    const s2 = await tx((t) => submitCount(t, staff, { id: c.id, version: 3 }));
    expect(s2.status).toBe("variance_review");

    await expect(tx((t) => approveCount(t, w.ctx, { id: c.id, version: 4 }))).rejects.toMatchObject({ code: "forbidden" }); // creator
    await expect(tx((t) => approveCount(t, staff, { id: c.id, version: 4 }))).rejects.toMatchObject({ code: "forbidden" }); // counter, no grant
    const view = await getCount(mgr, c.id);
    expect(view.lines[0]).toMatchObject({ current: "13", variance: "-1", afterApply: "12" });
    await tx((t) => approveCount(t, mgr, { id: c.id, version: 4 }));

    // Apply races a posting: whichever goes first, the count takes exactly 1 off.
    const [applied] = await Promise.all([tx((t) => applyCount(t, mgr, { id: c.id, version: 5 })), bump(v.id, 3)]);
    expect(applied.status).toBe("applied");
    expect(await onHand(v.id)).toBe("15");
    const l = await lineOf(c.id, v.id);
    expect(l.variance?.toString()).toBe("-1");
    const moves = await db.inventoryMovement.findMany({ where: { sourceType: "stock_count", sourceId: c.id } });
    expect(moves.map((m) => [m.type, m.dOnHand.toString(), m.reasonCode])).toEqual([["adjustment_out", "-1", "count"]]);
    await expect(tx((t) => cancelCount(t, mgr, { id: c.id, version: 6 }))).rejects.toMatchObject({ code: "invalid_transition" });
  });

  test("found item in a new bin; reviewer recount; inbox approve; I-07 blocks a loss of reserved units", async () => {
    const v = await newVariant();
    await bump(v.id, 5);
    const c = await tx((t) => openCount(t, w.ctx, { warehouseId: w.warehouse.id, variantIds: [v.id] }));
    await tx((t) => enterCounts(t, staff, { id: c.id, entries: [{ lineId: c.lines[0].id, countedQty: 5 }, { binId: recv, variantId: v.id, countedQty: 1 }] }));
    let s = await tx((t) => submitCount(t, staff, { id: c.id, version: 1 })); // found 1 where system had 0 → forced recount
    await tx((t) => enterCounts(t, staff, { id: c.id, entries: [{ binId: recv, variantId: v.id, countedQty: 1 }] }));
    s = await tx(async (t) => submitCount(t, staff, { id: c.id, version: await ver(c.id) }));
    expect(s.status).toBe("variance_review");
    // reviewer asks again for line 1
    s = await tx(async (t) => recountCount(t, mgr, { id: c.id, version: await ver(c.id), lineIds: [c.lines[0].id] }));
    expect(s.status).toBe("counting");
    await tx((t) => enterCounts(t, staff, { id: c.id, entries: [{ lineId: c.lines[0].id, countedQty: 3 }] }));
    s = await tx(async (t) => submitCount(t, staff, { id: c.id, version: await ver(c.id) })); // line 1 was recounted once → stands
    expect(s.status).toBe("variance_review");

    expect((await listInbox(staff)).items.find((i) => i.id === c.id)).toBeUndefined();
    const item = (await listInbox(mgr)).items.find((i) => i.id === c.id)!;
    expect(item).toMatchObject({ type: "stock_count", amount: "30.00" }); // |−2| + |+1| at WAC 10
    await tx((t) => decide(t, mgr, { type: "stock_count", id: c.id, version: item.version, approve: true }));
    // after apply the position holds 3 + 1 = 4; 5 reserved would be taken by the count (I-07)
    await tx((t) => reserve(t, w.ctx, { variantId: v.id, warehouseId: w.warehouse.id, qty: 4 }));
    const r2 = await tx((t) => reserve(t, w.ctx, { variantId: v.id, warehouseId: w.warehouse.id, qty: 1 }));
    const apply = (await listInbox(mgr)).items.find((i) => i.id === c.id && i.type === "count_apply")!;
    expect(apply).toBeDefined();
    await expect(tx((t) => applyCount(t, mgr, { id: c.id, version: apply.version! }))).rejects.toMatchObject({ code: "reserved_conflict" });
    await tx((t) => cancel(t, w.ctx, { reservationId: r2.reservation.id, version: 0 }));
    await tx((t) => applyCount(t, mgr, { id: c.id, version: apply.version! }));
    expect([await onHand(v.id), await onHand(v.id, recv)]).toEqual(["3", "1"]);
  });

  test("serialized found/loss: missing unit → lost, unknown unit created, lost unit found again", async () => {
    const v = await newVariant({ isSerialized: true });
    const ob = await opening([{ variantId: v.id, qty: 3, unitCost: 100, serials: [1, 2, 3].map((i) => `${v.sku}-${i}`) }]);
    await tx((t) => approveAdjustment(t, mgr, { id: ob.id, version: 1 }));
    const [s1, s2, s3, s9] = [1, 2, 3, 9].map((i) => `${v.sku}-${i}`);

    const c = await tx((t) => openCount(t, w.ctx, { warehouseId: w.warehouse.id, variantIds: [v.id] }));
    await expect(tx((t) => enterCounts(t, staff, { id: c.id, entries: [{ binId: recv, variantId: v.id, serials: [s1] }] })))
      .rejects.toMatchObject({ code: "validation_error", details: { serials: [s1] } }); // live in MAIN
    await tx((t) => enterCounts(t, staff, { id: c.id, entries: [{ lineId: c.lines[0].id, serials: [s1, s2, s9] }] }));
    const s = await tx((t) => submitCount(t, staff, { id: c.id, version: 1 }));
    expect(s.status).toBe("variance_review"); // qty 3 = 3
    await tx((t) => approveCount(t, mgr, { id: c.id, version: 2 }));
    await tx((t) => applyCount(t, mgr, { id: c.id, version: 3 }));
    const units = await db.serialUnit.findMany({ where: { variantId: v.id }, orderBy: { serialNo: "asc" } });
    expect(units.map((u) => [u.serialNo, u.status])).toEqual([[s1, "in_stock"], [s2, "in_stock"], [s3, "lost"], [s9, "in_stock"]]);
    expect(await onHand(v.id)).toBe("3");

    const c2 = await tx((t) => openCount(t, w.ctx, { warehouseId: w.warehouse.id, variantIds: [v.id] }));
    await tx((t) => enterCounts(t, staff, { id: c2.id, entries: [{ lineId: c2.lines[0].id, serials: [s1, s2, s3, s9] }] }));
    expect((await tx((t) => submitCount(t, staff, { id: c2.id, version: 1 }))).status).toBe("counting"); // +1 of 3 → recount
    await tx((t) => enterCounts(t, staff, { id: c2.id, entries: [{ lineId: c2.lines[0].id, serials: [s1, s2, s3, s9] }] }));
    expect((await tx(async (t) => submitCount(t, staff, { id: c2.id, version: await ver(c2.id) }))).status).toBe("variance_review");
    await tx(async (t) => approveCount(t, mgr, { id: c2.id, version: await ver(c2.id) }));
    await tx(async (t) => applyCount(t, mgr, { id: c2.id, version: await ver(c2.id) }));
    expect((await db.serialUnit.findFirstOrThrow({ where: { serialNo: s3 } })).status).toBe("in_stock");
    expect(await onHand(v.id)).toBe("4");
  });

  test("WH-02/03: an open count blocks warehouse and bin archive until cancelled", async () => {
    const wh = await tx((t) => createWarehouse(t, w.ctx, { code: `WH-${++n}`, name: "Spare" }));
    const bin = await tx((t) => createBin(t, w.ctx, { warehouseId: w.warehouse.id, code: `B-${n}`, type: "sellable" }));
    const c1 = await tx((t) => openCount(t, w.ctx, { warehouseId: wh.id }));
    const c2 = await tx((t) => openCount(t, w.ctx, { warehouseId: w.warehouse.id, binId: bin.id }));
    await expect(tx((t) => updateWarehouse(t, w.ctx, { id: wh.id, version: wh.version, status: "archived" }))).rejects.toMatchObject({ code: "conflict", details: { openCounts: 1 } });
    await expect(tx((t) => updateBin(t, w.ctx, { id: bin.id, version: bin.version, archived: true }))).rejects.toMatchObject({ code: "conflict", details: { reason: "open_count" } });
    await tx((t) => cancelCount(t, w.ctx, { id: c1.id, version: 0 }));
    await tx((t) => cancelCount(t, w.ctx, { id: c2.id, version: 0 }));
    await tx((t) => updateWarehouse(t, w.ctx, { id: wh.id, version: wh.version, status: "archived" }));
    await tx((t) => updateBin(t, w.ctx, { id: bin.id, version: bin.version, archived: true }));
  });
});

describe("opening balance (flow 26, MV-04)", () => {
  test("dual control, backdated as of, value at T includes it only from as-of", async () => {
    const v = await newVariant();
    const asOf = new Date(Date.now() - 30 * 86_400_000);
    const ob = await opening([{ variantId: v.id, qty: 4, unitCost: "2.5" }], asOf);
    await expect(tx((t) => approveAdjustment(t, w.ctx, { id: ob.id, version: 1 }))).rejects.toMatchObject({ code: "forbidden", details: { reason: "creator_is_approver" } });
    const ok = await tx((t) => approveAdjustment(t, mgr, { id: ob.id, version: 1 }));
    expect(ok.status).toBe("applied");
    const m = await db.inventoryMovement.findFirstOrThrow({ where: { sourceId: ob.id } });
    expect([m.type, m.createdAt.toISOString(), m.valueDelta.toString()]).toEqual(["opening_balance", asOf.toISOString(), "10"]);
    const line = (r: Awaited<ReturnType<typeof valueAt>>) => r.lines.find((l) => l.variantId === v.id);
    expect(line(await valueAt(w.ctx, new Date(asOf.getTime() - 1000)))).toBeUndefined();
    expect(line(await valueAt(w.ctx, new Date(asOf.getTime() + 1000)))).toMatchObject({ qty: "4", value: "10" });
  });

  test("refused for an item with history, a future date, a missing cost; DB rejects other backdated postings", async () => {
    const v = await newVariant();
    await expect(tx((t) => createAdjustment(t, w.ctx, { kind: "opening", warehouseId: w.warehouse.id, reasonCode: "x", asOf: new Date(Date.now() + 86_400_000), lines: [{ variantId: v.id, qty: 1, unitCost: 1 }] })))
      .rejects.toMatchObject({ code: "validation_error", details: { field: "asOf" } });
    await expect(tx((t) => createAdjustment(t, w.ctx, { kind: "opening", warehouseId: w.warehouse.id, reasonCode: "x", lines: [{ variantId: v.id, qty: 1 }] })))
      .rejects.toMatchObject({ code: "validation_error", details: { field: "unitCost" } });
    await expect(tx((t) => createAdjustment(t, w.ctx, { kind: "adjustment", warehouseId: w.warehouse.id, reasonCode: "x", asOf: new Date(), lines: [{ variantId: v.id, qty: 1 }] })))
      .rejects.toMatchObject({ code: "validation_error", details: { field: "asOf" } });
    const ob = await opening([{ variantId: v.id, qty: 1, unitCost: 1 }]);
    await bump(v.id, 1);
    await expect(tx((t) => approveAdjustment(t, mgr, { id: ob.id, version: 1 }))).rejects.toMatchObject({ code: "conflict", details: { reason: "has_history" } });
    await expect(tx((t) => postMovements(t, w.ctx, {
      sourceType: "test", sourceId: `t-${++n}`, postedAt: new Date(Date.now() - 86_400_000),
      legs: [{ type: "adjustment_in", variantId: v.id, warehouseId: w.warehouse.id, binId: main, delta: { onHand: 1 }, unitCost: 1, line: 1, reasonCode: "x" }],
    }))).rejects.toMatchObject({ code: "validation_error" });
    await expect(db.inventoryMovement.create({
      data: {
        companyId: w.company.id, variantId: v.id, warehouseId: w.warehouse.id, binId: main, type: "adjustment_in", dOnHand: 0, reservedAfter: 0,
        sourceType: "test", sourceId: "raw", reasonCode: "x", actorId: w.admin.id, idempotencyKey: `raw-${n}`, createdAt: new Date(Date.now() - 86_400_000),
      },
    })).rejects.toThrow(/MV-04/);
  });
});
