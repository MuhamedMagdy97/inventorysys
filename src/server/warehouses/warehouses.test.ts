import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { execute } from "@/server/core/execute";
import { db, transaction, type Tx } from "@/server/db";
import { postMovements } from "@/server/inventory/post";
import { release, reserve } from "@/server/inventory/reservations";
import { seedCompany } from "@/server/seed";
import { updateUserAccess } from "@/server/users/users";
import { loginUser } from "@/test/auth";
import { createBin, createWarehouse, getWarehouse, setWarehouseStaff, updateBin, updateWarehouse } from "./warehouses";

let w: Awaited<ReturnType<typeof seedCompany>>;
let n = 0;
const tx = <T>(fn: (tx: Tx) => Promise<T>) => transaction(fn);
const newWh = () => tx((t) => createWarehouse(t, w.ctx, { code: `wh-${++n}`, name: `WH ${n}` }));
const bin = (wh: { bins: { code: string; id: string; version: number }[] }, code: string) => wh.bins.find((b) => b.code === code)!;
const move = (warehouseId: string, binId: string, qty: number) => tx((t) => postMovements(t, w.ctx, {
  sourceType: "adjustment", sourceId: crypto.randomUUID(),
  legs: [{ type: qty > 0 ? "adjustment_in" : "adjustment_out", variantId: w.variants[0].id, warehouseId, binId, delta: { onHand: qty }, unitCost: 1, line: 1, reasonCode: "test" }],
}));

beforeAll(async () => { w = await seedCompany(`wh-${crypto.randomUUID()}`); });
afterAll(() => db.$disconnect());

test("flow 5: code normalised, 4 default bins; duplicate code → duplicate", async () => {
  const wh = await newWh();
  expect(wh.code).toBe(`WH-${n}`);
  expect(wh.bins.map((b) => b.code).sort()).toEqual(["DMG", "MAIN", "QUAR", "RECV"]);
  await expect(execute(w.ctx, { scope: "t" }, (t) => createWarehouse(t, w.ctx, { code: `wh-${n}`, name: "again" }))).rejects.toMatchObject({ code: "duplicate" });
});

describe("bins (WH-01/03)", () => {
  test("codes unique per warehouse; zone/rack/shelf optional", async () => {
    const wh = await newWh();
    const b = await tx((t) => createBin(t, w.ctx, { warehouseId: wh.id, code: "a-01", type: "sellable", zone: "a", rack: "1" }));
    expect(b).toMatchObject({ code: "A-01", zone: "A", rack: "1", shelf: null });
    await expect(execute(w.ctx, { scope: "t" }, (t) => createBin(t, w.ctx, { warehouseId: wh.id, code: "A-01", type: "sellable" }))).rejects.toMatchObject({ code: "duplicate" });
  });

  test("default bins can't be archived; making another default moves the flag", async () => {
    const wh = await newWh();
    const main = bin(wh, "MAIN");
    await expect(tx((t) => updateBin(t, w.ctx, { id: main.id, version: 0, archived: true }))).rejects.toMatchObject({ details: { reason: "default_bin" } });
    const b2 = await tx((t) => createBin(t, w.ctx, { warehouseId: wh.id, code: "S2", type: "sellable" }));
    await expect(tx((t) => updateBin(t, w.ctx, { id: bin(wh, "QUAR").id, version: 0, makeDefault: "sellable" }))).rejects.toMatchObject({ code: "validation_error" });
    await tx((t) => updateBin(t, w.ctx, { id: b2.id, version: 0, makeDefault: "sellable" }));
    const fresh = await db.bin.findUniqueOrThrow({ where: { id: main.id } });
    expect(fresh.isDefaultSellable).toBe(false);
    await tx((t) => updateBin(t, w.ctx, { id: main.id, version: fresh.version, archived: true }));
  });

  test("last quarantine/damaged bin stays", async () => {
    const wh = await newWh();
    await expect(tx((t) => updateBin(t, w.ctx, { id: bin(wh, "QUAR").id, version: 0, archived: true }))).rejects.toMatchObject({ details: { reason: "last_special_bin" } });
    await tx((t) => createBin(t, w.ctx, { warehouseId: wh.id, code: "QUAR2", type: "quarantine" }));
    await tx((t) => updateBin(t, w.ctx, { id: bin(wh, "QUAR").id, version: 0, archived: true }));
  });

  test("WH-03: archive blocked while stocked; once archived, postings into it are rejected", async () => {
    const wh = await newWh();
    const b = await tx((t) => createBin(t, w.ctx, { warehouseId: wh.id, code: "TMP", type: "sellable" }));
    await move(wh.id, b.id, 2);
    await expect(tx((t) => updateBin(t, w.ctx, { id: b.id, version: 0, archived: true }))).rejects.toMatchObject({ code: "conflict", details: { reason: "not_empty" } });
    await move(wh.id, b.id, -2);
    await tx((t) => updateBin(t, w.ctx, { id: b.id, version: 0, archived: true }));
    await expect(move(wh.id, b.id, 1)).rejects.toMatchObject({ code: "archived_conflict" });
  });

  test("archive vs concurrent posting: exactly one wins, never an archived bin with stock", async () => {
    const wh = await newWh();
    const b = await tx((t) => createBin(t, w.ctx, { warehouseId: wh.id, code: "RACE", type: "sellable" }));
    const results = await Promise.allSettled([move(wh.id, b.id, 1), tx((t) => updateBin(t, w.ctx, { id: b.id, version: 0, archived: true }))]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const fresh = await db.bin.findUniqueOrThrow({ where: { id: b.id } });
    const stock = await db.stockBalance.aggregate({ where: { binId: b.id }, _sum: { onHand: true } });
    expect(fresh.archived && Number(stock._sum.onHand ?? 0) > 0).toBe(false);
  });
});

describe("warehouse archive (WH-02, edge #5)", () => {
  test("blocked by stock and by open reservations; then allowed and terminal", async () => {
    const wh = await newWh();
    const main = bin(wh, "MAIN");
    await move(wh.id, main.id, 3);
    const archive = (version: number) => tx((t) => updateWarehouse(t, w.ctx, { id: wh.id, version, status: "archived" }));
    await expect(archive(0)).rejects.toMatchObject({ code: "conflict", details: { reason: "not_empty", stockPositions: 1 } });
    const r = await tx((t) => reserve(t, w.ctx, { variantId: w.variants[0].id, warehouseId: wh.id, qty: 1 }));
    await move(wh.id, main.id, -3 + 1); // leave 1 (reserved)
    await expect(archive(0)).rejects.toMatchObject({ details: { openReservations: 1 } });
    await tx((t) => release(t, w.ctx, { reservationId: r.reservation.id, version: r.reservation.version }));
    await move(wh.id, main.id, -1);
    const archived = await archive(0);
    expect(archived.status).toBe("archived");
    await expect(tx((t) => updateWarehouse(t, w.ctx, { id: wh.id, version: 1, status: "active" }))).rejects.toMatchObject({ code: "invalid_transition" });
    await expect(move(wh.id, bin(wh, "RECV").id, 1)).rejects.toMatchObject({ code: "archived_conflict" }); // edge #36
  });
});

describe("staff + manager", () => {
  test("assigning puts the warehouse in the user's scope; manager can't be unassigned or disabled", async () => {
    const wh = await newWh();
    const { user } = await loginUser(w, "warehouse_staff");
    await tx((t) => setWarehouseStaff(t, w.ctx, { warehouseId: wh.id, userId: user.id, assigned: true }));
    expect(await db.userWarehouse.count({ where: { userId: user.id, warehouseId: wh.id } })).toBe(1);

    await tx((t) => updateWarehouse(t, w.ctx, { id: wh.id, version: 0, managerUserId: user.id }));
    await expect(tx((t) => setWarehouseStaff(t, w.ctx, { warehouseId: wh.id, userId: user.id, assigned: false }))).rejects.toMatchObject({ details: { reason: "is_manager" } });
    const u = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    await expect(tx((t) => updateUserAccess(t, w.ctx, { userId: user.id, version: u.version, status: "disabled", roleIds: [], warehouseIds: [wh.id] })))
      .rejects.toMatchObject({ details: { reason: "is_manager" } });
  });

  test("assign_staff is scope-checked (no escalation)", async () => {
    const wh = await newWh();
    const { user } = await loginUser(w, "warehouse_staff");
    const scoped = { ...w.ctx, warehouseIds: [] as string[] };
    await expect(tx((t) => setWarehouseStaff(t, scoped, { warehouseId: wh.id, userId: user.id, assigned: true }))).rejects.toMatchObject({ code: "forbidden" });
  });

  test("bin totals only for inventory.view in scope", async () => {
    const view = await getWarehouse(w.ctx, w.warehouse.id);
    expect(view.binTotals).not.toBeNull();
    const noStock = { ...w.ctx, permissions: new Set(["warehouses.view"]) };
    expect((await getWarehouse(noStock, w.warehouse.id)).binTotals).toBeNull();
  });
});
