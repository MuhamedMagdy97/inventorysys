import { afterAll, beforeAll, expect, test } from "vitest";
import { db, transaction } from "@/server/db";
import { seedCompany } from "@/server/seed";
import { getAvailability } from "./availability";
import { postMovements } from "./post";
import { reconcile } from "./reconcile";
import { reserve } from "./reservations";

let w: Awaited<ReturnType<typeof seedCompany>>;
let main: string;

beforeAll(async () => {
  w = await seedCompany(`rec-${crypto.randomUUID()}`);
  main = w.warehouse.bins.find((b) => b.code === "MAIN")!.id;
  await transaction((tx) => postMovements(tx, w.ctx, {
    sourceType: "opening", sourceId: "ob",
    legs: [{ type: "opening_balance", variantId: w.variants[0].id, warehouseId: w.warehouse.id, binId: main, delta: { onHand: 10 }, unitCost: 3, line: 1, reasonCode: "opening" }],
  }));
  await transaction((tx) => reserve(tx, w.ctx, { variantId: w.variants[0].id, warehouseId: w.warehouse.id, qty: 4 }));
});
afterAll(() => db.$disconnect());

test("getAvailability = on_hand − reserved", async () => {
  const a = await getAvailability(w.ctx, { variantId: w.variants[0].id, warehouseId: w.warehouse.id });
  expect([a.onHand, a.reserved, a.available]).toEqual(["10", "4", "6"]);
  await expect(getAvailability({ ...w.ctx, warehouseIds: [] }, { variantId: w.variants[0].id, warehouseId: w.warehouse.id }))
    .rejects.toMatchObject({ code: "forbidden" });
});

test("reconcile is clean on consistent data and reports drift when a cache is tampered with", async () => {
  expect(await reconcile(w.ctx)).toEqual([]);
  const row = await db.stockBalance.findFirstOrThrow({ where: { binId: main, variantId: w.variants[0].id } });
  const alloc = await db.stockAllocation.findFirstOrThrow({ where: { variantId: w.variants[0].id } });
  await db.stockBalance.update({ where: { id: row.id }, data: { onHand: 11 } });
  await db.stockAllocation.update({ where: { id: alloc.id }, data: { qtyReserved: 3 } });
  try {
    const drift = await reconcile(w.ctx);
    expect(drift.map((d) => d.check).sort()).toEqual(["balance", "reserved"]);
    expect(drift.find((d) => d.check === "balance")).toMatchObject({ expected: "10/0/0/0", actual: "11/0/0/0" });
  } finally {
    await db.stockBalance.update({ where: { id: row.id }, data: { onHand: 10 } });
    await db.stockAllocation.update({ where: { id: alloc.id }, data: { qtyReserved: 4 } });
  }
  expect(await reconcile(w.ctx)).toEqual([]);
});
