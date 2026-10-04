import { afterAll, beforeAll, expect, test } from "vitest";
import { db, transaction } from "@/server/db";
import { seedCompany } from "@/server/seed";
import { postMovements, type Leg } from "./post";
import { fulfil, reserve } from "./reservations";
import { liveValue, valueAt } from "./valuation";

let w: Awaited<ReturnType<typeof seedCompany>>;
let v: string;
let main: string;
let n = 0;
const post = (leg: Omit<Leg, "variantId" | "warehouseId" | "line" | "reasonCode">) =>
  transaction((tx) => postMovements(tx, w.ctx, {
    sourceType: "test", sourceId: `t-${++n}`,
    legs: [{ variantId: v, warehouseId: w.warehouse.id, line: 1, reasonCode: "t", ...leg }],
  }));
const settle = () => new Promise((r) => setTimeout(r, 20)); // distinct created_at per step

beforeAll(async () => {
  w = await seedCompany(`val-${crypto.randomUUID()}`);
  v = w.variants[0].id;
  main = w.warehouse.bins.find((b) => b.code === "MAIN")!.id;
});
afterAll(() => db.$disconnect());

test("WAC moves on inbound legs; outbound relieves at WAC; valueAt(T) replays snapshots", async () => {
  await post({ type: "purchase_receipt", binId: main, delta: { onHand: 10 }, unitCost: 5 });
  await settle();
  const t1 = new Date();
  await settle();
  await post({ type: "purchase_receipt", binId: main, delta: { onHand: 10 }, unitCost: 7 });
  let live = await liveValue(w.ctx);
  expect(live.lines[0]).toMatchObject({ qty: "20", value: "120", wac: "6" });

  const { reservation } = await transaction((tx) => reserve(tx, w.ctx, { variantId: v, warehouseId: w.warehouse.id, qty: 5 }));
  const f = await transaction((tx) => fulfil(tx, w.ctx, { reservationId: reservation.id, version: 0 }));
  const sale = await db.inventoryMovement.findFirstOrThrow({ where: { id: f.movementIds[0] } });
  expect([sale.unitCost?.toString(), sale.valueDelta.toString()]).toEqual(["6", "-30"]); // WAC-at-fulfil snapshot (INV-022)

  await post({ type: "damage", binId: main, delta: { onHand: -2, damaged: 2 } }); // still valued until disposal
  await post({ type: "purchase_receipt", binId: main, delta: { onHand: 3 }, unitCost: "9.3333" });
  await settle();

  expect((await valueAt(w.ctx, t1)).total).toBe("50");
  live = await liveValue(w.ctx);
  const now = await valueAt(w.ctx, new Date());
  expect(now.total).toBe(live.total); // INV-022: replay(now) == live valuation, exactly
  expect(now.lines).toEqual(live.lines);
  expect(live.total).toBe("117.9999"); // 120 − 30 + 27.9999
});
