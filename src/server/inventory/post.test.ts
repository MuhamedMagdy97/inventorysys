import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createBatch, createProduct } from "@/server/catalog/catalog";
import { db, transaction } from "@/server/db";
import { seedCompany } from "@/server/seed";
import { createWarehouse } from "@/server/warehouses/warehouses";
import { postMovements, type Leg } from "./post";

let w: Awaited<ReturnType<typeof seedCompany>>;
let bin: Record<string, string>; // code → id
let v: string; // untracked variant
let src = 0;

const post = (legs: Partial<Leg>[], sourceId = `doc-${++src}`) =>
  transaction((tx) =>
    postMovements(tx, w.ctx, {
      sourceType: "adjustment",
      sourceId,
      legs: legs.map((l, i) => ({
        variantId: v, warehouseId: w.warehouse.id, line: i + 1, reasonCode: "test", ...l,
      })) as Leg[],
    }),
  );

const bal = async (code: string, variantId = v, batchId: string | null = null) =>
  db.stockBalance.findFirstOrThrow({ where: { variantId, binId: bin[code], batchId } });
const cost = () => db.variantCost.findUniqueOrThrow({ where: { variantId_warehouseId: { variantId: v, warehouseId: w.warehouse.id } } });
const alloc = () => db.stockAllocation.findFirstOrThrow({ where: { variantId: v, warehouseId: w.warehouse.id, batchId: null } });

beforeAll(async () => {
  w = await seedCompany(`post-${crypto.randomUUID()}`);
  bin = Object.fromEntries(w.warehouse.bins.map((b) => [b.code, b.id]));
  v = w.variants[0].id;
});
afterAll(() => db.$disconnect());

describe("movement types (doc 08 §3)", () => {
  test("opening_balance: +on_hand at cost, audit + after-values written", async () => {
    const r = await post([{ type: "opening_balance", binId: bin.MAIN, delta: { onHand: 10 }, unitCost: 5 }]);
    const m = r.movements[0];
    expect(m.onHandAfter?.toString()).toBe("10");
    expect(m.reservedAfter.toString()).toBe("0");
    expect(m.unitCost?.toString()).toBe("5");
    expect(m.valueDelta.toString()).toBe("50");
    expect(m.idempotencyKey).toBe(`adjustment:doc-${src}:1:1`);
    expect(await db.auditLog.findUnique({ where: { id: r.auditId } })).toMatchObject({ action: "post", entityId: `doc-${src}` });
    expect((await cost()).value.toString()).toBe("50");
  });

  test("purchase_receipt: +on_hand and +damaged in one posting; WAC moves", async () => {
    await post([
      { type: "purchase_receipt", binId: bin.MAIN, delta: { onHand: 5 }, unitCost: 8 },
      { type: "purchase_receipt", binId: bin.DMG, delta: { damaged: 1 }, unitCost: 8 },
    ]);
    expect((await bal("MAIN")).onHand.toString()).toBe("15");
    expect((await bal("DMG")).damaged.toString()).toBe("1");
    const c = await cost();
    expect([c.qty.toString(), c.value.toString()]).toEqual(["16", "98"]); // 50 + 40 + 8
  });

  test("adjustment_in defaults to current WAC; adjustment_out relieves at WAC", async () => {
    const wac = (98 / 16).toFixed(4); // 6.125
    const r = await post([{ type: "adjustment_in", binId: bin.MAIN, delta: { onHand: 4 } }]);
    expect(r.movements[0].unitCost?.toString()).toBe(Number(wac).toString());
    const out = await post([{ type: "adjustment_out", binId: bin.MAIN, delta: { onHand: -2 } }]);
    expect(out.movements[0].valueDelta.toString()).toBe("-12.25");
    expect((await bal("MAIN")).onHand.toString()).toBe("17");
  });

  test("bucket moves: damage, repair_to_stock, expiry, disposal", async () => {
    await post([{ type: "damage", binId: bin.MAIN, delta: { onHand: -2, damaged: 2 } }]);
    await post([{ type: "repair_to_stock", binId: bin.MAIN, delta: { damaged: -1, onHand: 1 } }]);
    await post([{ type: "expiry", binId: bin.MAIN, delta: { onHand: -1, expired: 1 } }]);
    const before = (await cost()).value;
    const d = await post([{ type: "disposal", binId: bin.MAIN, delta: { expired: -1, damaged: -1 } }]);
    expect(d.movements[0].valueDelta.lt(0)).toBe(true);
    expect((await cost()).value.toString()).toBe(before.plus(d.movements[0].valueDelta).toString());
    const b = await bal("MAIN");
    expect([b.onHand, b.damaged, b.expired].map(String)).toEqual(["15", "0", "0"]);
  });

  test("quarantine flows: blocked_in/release/reject, sale_return_quarantine/restock", async () => {
    await post([{ type: "blocked_in", binId: bin.QUAR, delta: { blocked: 3 }, unitCost: 6 }]);
    await post([{ type: "blocked_release", binId: bin.QUAR, delta: { blocked: -1, onHand: 1 } }]);
    await post([{ type: "blocked_reject", binId: bin.QUAR, delta: { blocked: -1, damaged: 1 } }]);
    await post([{ type: "sale_return_quarantine", binId: bin.QUAR, delta: { blocked: 1 }, unitCost: 6 }]);
    await post([{ type: "sale_return_restock", binId: bin.QUAR, delta: { blocked: -1, onHand: 1 } }]);
    const q = await bal("QUAR");
    expect([q.onHand, q.blocked, q.damaged].map(String)).toEqual(["2", "1", "1"]);
  });

  test("putaway: paired legs net zero; an unpaired leg is rejected", async () => {
    await post([
      { type: "putaway_out", binId: bin.QUAR, delta: { onHand: -2 } },
      { type: "putaway_in", binId: bin.MAIN, delta: { onHand: 2 }, line: 2 },
    ]);
    expect((await bal("MAIN")).onHand.toString()).toBe("17");
    await expect(post([{ type: "putaway_out", binId: bin.MAIN, delta: { onHand: -1 } }])).rejects.toMatchObject({ code: "validation_error" });
  });

  test("transfer_out / transfer_in carry the source cost to another warehouse", async () => {
    const wh2 = await transaction((tx) => createWarehouse(tx, w.ctx, { code: `WH2-${src}`, name: "Second" }));
    const out = await post([{ type: "transfer_out", binId: bin.MAIN, delta: { onHand: -3 } }]);
    const snap = out.movements[0].unitCost!;
    const main2 = wh2.bins.find((b) => b.code === "MAIN")!.id;
    const inn = await post([{ type: "transfer_in", warehouseId: wh2.id, binId: main2, delta: { onHand: 3 }, unitCost: snap.toString() }]);
    expect(inn.movements[0].unitCost?.toString()).toBe(snap.toString());
    await post([{ type: "purchase_return", binId: bin.MAIN, delta: { onHand: -1 } }]);
    expect((await bal("MAIN")).onHand.toString()).toBe("13");
  });

  test("reservation → partial sale_fulfilment → reservation_release", async () => {
    await post([{ type: "reservation", delta: { reserved: 5 } }]);
    const f = await post([{ type: "sale_fulfilment", binId: bin.MAIN, delta: { onHand: -2, reserved: -2 } }]);
    expect(f.movements[0].reservedAfter.toString()).toBe("3");
    expect(f.movements[0].unitCost).not.toBeNull();
    await post([{ type: "reservation_release", delta: { reserved: -3 } }]);
    expect((await alloc()).qtyReserved.toString()).toBe("0");
  });
});

describe("invariants", () => {
  test("I-03: a bucket can't go negative → insufficient_stock, nothing written", async () => {
    const n = await db.inventoryMovement.count({ where: { companyId: w.company.id } });
    await expect(post([{ type: "adjustment_out", binId: bin.MAIN, delta: { onHand: -999 } }])).rejects.toMatchObject({ code: "insufficient_stock" });
    expect(await db.inventoryMovement.count({ where: { companyId: w.company.id } })).toBe(n);
  });

  test("I-01: reserving more than available → insufficient_stock", async () => {
    const onHand = (await db.stockBalance.aggregate({ where: { variantId: v, warehouseId: w.warehouse.id }, _sum: { onHand: true } }))._sum.onHand!;
    await expect(post([{ type: "reservation", delta: { reserved: onHand.plus(1).toString() } }])).rejects.toMatchObject({ code: "insufficient_stock" });
  });

  test("I-07: removing reserved units → reserved_conflict", async () => {
    const onHand = (await db.stockBalance.aggregate({ where: { variantId: v, warehouseId: w.warehouse.id }, _sum: { onHand: true } }))._sum.onHand!;
    await post([{ type: "reservation", delta: { reserved: onHand.minus(1).toString() } }]);
    await expect(post([{ type: "damage", binId: bin.MAIN, delta: { onHand: -2, damaged: 2 } }])).rejects.toMatchObject({ code: "reserved_conflict" });
    await post([{ type: "damage", binId: bin.MAIN, delta: { onHand: -1, damaged: 1 } }]); // the free unit is fine
    await post([{ type: "reservation_release", delta: { reserved: onHand.minus(1).neg().toString() } }]);
  });

  test("shape validation: wrong sign, bin on reservation, unbalanced move, zero leg", async () => {
    for (const leg of [
      { type: "adjustment_in", binId: bin.MAIN, delta: { onHand: -1 } },
      { type: "reservation", binId: bin.MAIN, delta: { reserved: 1 } },
      { type: "damage", binId: bin.MAIN, delta: { onHand: -2, damaged: 1 } },
      { type: "adjustment_in", binId: bin.MAIN, delta: {} },
      { type: "adjustment_in", binId: bin.MAIN, delta: { onHand: "0.00001" } },
      { type: "transfer_variance", binId: bin.MAIN, delta: {} },
    ] as Partial<Leg>[]) {
      await expect(post([leg])).rejects.toMatchObject({ code: "validation_error" });
    }
  });

  test("batch required for tracked products, refused for untracked", async () => {
    const p = await transaction((tx) => createProduct(tx, w.ctx, { name: "Milk", requiresBatch: true, requiresExpiry: true, variants: [{ sku: `MILK-${src}` }] }));
    const mv = p.variants[0].id;
    const b = await transaction((tx) => createBatch(tx, w.ctx, { variantId: mv, batchNo: "B1", expiryDate: new Date("2030-01-01") }));
    await expect(post([{ type: "opening_balance", variantId: mv, binId: bin.MAIN, delta: { onHand: 1 }, unitCost: 1 }])).rejects.toMatchObject({ code: "validation_error" });
    await expect(post([{ type: "opening_balance", binId: bin.MAIN, batchId: b.id, delta: { onHand: 1 }, unitCost: 1 }])).rejects.toMatchObject({ code: "not_found" });
    await post([{ type: "opening_balance", variantId: mv, binId: bin.MAIN, batchId: b.id, delta: { onHand: 1 }, unitCost: 1 }]);
    expect((await bal("MAIN", mv, b.id)).onHand.toString()).toBe("1");
  });

  test("company + warehouse scope: other company's variant is not_found; out-of-scope is forbidden", async () => {
    const other = await seedCompany(`other-${crypto.randomUUID()}`);
    await expect(post([{ type: "opening_balance", variantId: other.variants[0].id, binId: bin.MAIN, delta: { onHand: 1 }, unitCost: 1 }])).rejects.toMatchObject({ code: "not_found" });
    const scoped = { ...w.ctx, warehouseIds: [other.warehouse.id] };
    await expect(transaction((tx) => postMovements(tx, scoped, {
      sourceType: "adjustment", sourceId: "x",
      legs: [{ type: "opening_balance", variantId: v, warehouseId: w.warehouse.id, binId: bin.MAIN, delta: { onHand: 1 }, unitCost: 1, line: 1, reasonCode: "t" }],
    }))).rejects.toMatchObject({ code: "forbidden" });
  });

  test("MV-02: re-posting the same source is a no-op; a partial overlap is a duplicate", async () => {
    const legs: Partial<Leg>[] = [{ type: "adjustment_in", binId: bin.MAIN, delta: { onHand: 1 } }];
    const first = await post(legs, "same-doc");
    const before = (await bal("MAIN")).onHand.toString();
    const again = await post(legs, "same-doc");
    expect(again.replayed).toBe(true);
    expect(again.movements.map((m) => m.id)).toEqual(first.movements.map((m) => m.id));
    expect((await bal("MAIN")).onHand.toString()).toBe(before);
    await expect(post([...legs, { type: "adjustment_in", binId: bin.MAIN, delta: { onHand: 1 }, line: 2 }], "same-doc"))
      .rejects.toMatchObject({ code: "duplicate" });
  });

  test("last units out take the remaining value exactly", async () => {
    const all = await db.stockBalance.findMany({ where: { variantId: v, warehouseId: w.warehouse.id, batchId: null } });
    const legs: Partial<Leg>[] = [];
    for (const b of all) {
      if (b.onHand.gt(0)) legs.push({ type: "adjustment_out", binId: b.binId, delta: { onHand: b.onHand.neg().toString() } });
      const rest = { blocked: b.blocked, damaged: b.damaged, expired: b.expired };
      const d = Object.fromEntries(Object.entries(rest).filter(([, x]) => x.gt(0)).map(([k, x]) => [k, x.neg().toString()]));
      if (Object.keys(d).length) legs.push({ type: "disposal", binId: b.binId, delta: d });
    }
    await post(legs.map((l, i) => ({ ...l, line: i + 1 })));
    const c = await cost();
    expect([c.qty.toString(), c.value.toString()]).toEqual(["0", "0"]);
  });
});
