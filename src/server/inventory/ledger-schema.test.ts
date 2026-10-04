import { afterAll, beforeAll, expect, test } from "vitest";
import { db } from "@/server/db";
import { seedCompany } from "@/server/seed";

// T1.3: these guarantees hold even if app code is wrong — the DB rejects them.
let w: Awaited<ReturnType<typeof seedCompany>>;
let movementId: string;
const leg = () => ({
  companyId: w.company.id, variantId: w.variants[0].id, warehouseId: w.warehouse.id,
  binId: w.warehouse.bins[0].id, type: "adjustment_in" as const, dOnHand: 1, onHandAfter: 1,
  reservedAfter: 0, sourceType: "adjustment", sourceId: "t", reasonCode: "test", actorId: w.admin.id,
  idempotencyKey: "adjustment:t:1:1",
});

beforeAll(async () => {
  w = await seedCompany(`schema-${crypto.randomUUID()}`);
  movementId = (await db.inventoryMovement.create({ data: leg() })).id;
  // keep the cache consistent with that raw leg, so the end-of-suite reconciler stays clean
  const { companyId, variantId, warehouseId, binId } = leg();
  await db.stockBalance.create({ data: { companyId, variantId, warehouseId, binId, onHand: 1 } });
  await db.stockAllocation.create({ data: { companyId, variantId, warehouseId } });
  await db.variantCost.create({ data: { companyId, variantId, warehouseId, qty: 1 } });
});
afterAll(() => db.$disconnect());

test("negative bucket rejected by CHECK", async () => {
  const base = { companyId: w.company.id, variantId: w.variants[0].id, warehouseId: w.warehouse.id };
  await expect(db.stockBalance.create({ data: { ...base, binId: w.warehouse.bins[0].id, onHand: -1 } }))
    .rejects.toThrow(/stock_balance_on_hand_nonneg/);
  await expect(db.stockAllocation.create({ data: { ...base, qtyReserved: -1 } }))
    .rejects.toThrow(/stock_allocation_reserved_nonneg/);
});

test("UPDATE / DELETE on a movement rejected by trigger", async () => {
  await expect(db.$executeRaw`UPDATE inventory_movement SET d_on_hand = 5 WHERE id = ${movementId}`)
    .rejects.toThrow(/append-only/);
  await expect(db.$executeRaw`DELETE FROM inventory_movement WHERE id = ${movementId}`)
    .rejects.toThrow(/append-only/);
});

test("UPDATE on audit_log rejected by trigger", async () => {
  await expect(db.$executeRaw`UPDATE audit_log SET action = 'x' WHERE company_id = ${w.company.id}`)
    .rejects.toThrow(/append-only/);
});

test("duplicate leg idempotency key rejected by UNIQUE", async () => {
  await expect(db.inventoryMovement.create({ data: leg() })).rejects.toThrow(/Unique constraint/);
});

test("position keys are unique even with NULL batch", async () => {
  const base = { companyId: w.company.id, variantId: w.variants[1].id, warehouseId: w.warehouse.id };
  await db.stockAllocation.create({ data: base });
  await expect(db.stockAllocation.create({ data: base })).rejects.toThrow(/Unique constraint/);
  await db.stockBalance.create({ data: { ...base, binId: w.warehouse.bins[0].id } });
  await expect(db.stockBalance.create({ data: { ...base, binId: w.warehouse.bins[0].id } }))
    .rejects.toThrow(/Unique constraint/);
});
