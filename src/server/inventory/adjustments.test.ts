import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { decide, listInbox } from "@/server/approvals/inbox";
import { buildCtx } from "@/server/auth/session-ctx";
import { createProduct } from "@/server/catalog/catalog";
import type { Ctx } from "@/server/core/ctx";
import { db, transaction, type Tx } from "@/server/db";
import { createLoginUser, seedCompany } from "@/server/seed";
import {
  applyAdjustment, approveAdjustment, cancelAdjustment, createAdjustment, rejectAdjustment, submitAdjustment,
  type AdjustmentLineInput,
} from "./adjustments";
import type { AdjustmentKind } from "@/generated/prisma/client";
import { postMovements } from "./post";
import { reconcile } from "./reconcile";
import { cancel, reserve } from "./reservations";

// Part 6 gate (P6): flows 12, 17, 27, 28 + the Approvals Inbox (doc 25).

let w: Awaited<ReturnType<typeof seedCompany>>;
let mgr: Ctx; // inventory_manager: adjust/damage/repair/dispose approve ≤ 1000
let owner: Ctx; // unlimited approvals, no posting grants (SoD)
let main: string;
let n = 0;
const tx = <T>(fn: (tx: Tx) => Promise<T>) => transaction(fn);

async function userCtx(role: string) {
  const roleId = w.roles.find((r) => r.code === role)!.id;
  const u = await tx((t) => createLoginUser(t, w.company.id, { name: role, email: `${role}+${crypto.randomUUID()}@test.invalid`, password: "x", roleId }));
  return buildCtx(u.id, { requestId: crypto.randomUUID(), channel: "system" });
}
async function newVariant(flags: { isSerialized?: boolean } = {}) {
  const p = await tx((t) => createProduct(t, w.ctx, { name: `Item ${crypto.randomUUID().slice(0, 8)}`, ...flags, variants: [{ sku: `SKU-${crypto.randomUUID().slice(0, 8)}` }] }));
  return p.variants[0];
}
const stock = (variantId: string, qty: number, unitCost = 10, serialized = false) =>
  tx((t) => postMovements(t, w.ctx, {
    sourceType: "opening", sourceId: `ob-${++n}`,
    legs: [{ type: "opening_balance", variantId, warehouseId: w.warehouse.id, binId: main, delta: { onHand: qty }, unitCost, line: 1, reasonCode: "opening", ...(serialized ? { serialized: true as const } : {}) }],
  }));
const buckets = async (variantId: string) => {
  const r = await db.stockBalance.aggregate({ where: { variantId }, _sum: { onHand: true, damaged: true, expired: true, blocked: true } });
  return [r._sum.onHand, r._sum.damaged].map((d) => d?.toString() ?? "0");
};
// draft (admin) → submitted
async function submitted(kind: AdjustmentKind, lines: AdjustmentLineInput[], reasonCode = "count_fix") {
  const a = await tx((t) => createAdjustment(t, w.ctx, { kind, warehouseId: w.warehouse.id, reasonCode, lines }));
  return tx((t) => submitAdjustment(t, w.ctx, { id: a.id, version: 0 }));
}

beforeAll(async () => {
  w = await seedCompany(`adj-${crypto.randomUUID()}`);
  [mgr, owner] = await Promise.all([userCtx("inventory_manager"), userCtx("owner")]);
  main = w.warehouse.bins.find((b) => b.code === "MAIN")!.id;
});
afterAll(async () => {
  expect(await reconcile(w.ctx)).toEqual([]);
  await db.$disconnect();
});

describe("adjustments (flow 12)", () => {
  test("found + loss: SoD, limit, approve then apply (separate grant), version-checked", async () => {
    const v = await newVariant();
    await stock(v.id, 10, 10);
    const a = await submitted("adjustment", [{ variantId: v.id, qty: 3, unitCost: 12 }, { variantId: v.id, qty: -5 }]);
    await expect(tx((t) => approveAdjustment(t, w.ctx, { id: a.id, version: 1 }))).rejects.toMatchObject({ code: "forbidden", details: { reason: "creator_is_approver" } });
    const ok = await tx((t) => approveAdjustment(t, mgr, { id: a.id, version: 1 })); // 3×12 + 5×10 = 86 ≤ 1000
    expect(ok.status).toBe("approved");
    expect(await buckets(v.id)).toEqual(["10", "0"]); // nothing posted before apply
    await expect(tx((t) => applyAdjustment(t, owner, { id: a.id, version: 2 }))).rejects.toMatchObject({ code: "forbidden" }); // owner holds no posting grant
    await expect(tx((t) => applyAdjustment(t, mgr, { id: a.id, version: 1 }))).rejects.toMatchObject({ code: "version_conflict" });
    const applied = await tx((t) => applyAdjustment(t, mgr, { id: a.id, version: 2 }));
    expect(applied.status).toBe("applied");
    expect(await buckets(v.id)).toEqual(["8", "0"]);
    const moves = await db.inventoryMovement.findMany({ where: { sourceId: a.id }, orderBy: { id: "asc" } });
    expect(moves.map((m) => [m.type, m.dOnHand.toString(), m.unitCost?.toString()])).toEqual([["adjustment_in", "3", "12"], ["adjustment_out", "-5", "10.4615"]]);
    await expect(tx((t) => cancelAdjustment(t, w.ctx, { id: a.id, version: 3 }))).rejects.toMatchObject({ code: "invalid_transition" }); // applied is terminal
  });

  test("INV-020 over-limit → forbidden for the manager, owner can approve; reject → draft needs a comment", async () => {
    const v = await newVariant();
    await stock(v.id, 200, 10);
    const a = await submitted("adjustment", [{ variantId: v.id, qty: -150 }]); // 1500 > 1000
    await expect(tx((t) => approveAdjustment(t, mgr, { id: a.id, version: 1 }))).rejects.toMatchObject({ code: "forbidden", details: { reason: "over_limit" } });
    await expect(tx((t) => rejectAdjustment(t, mgr, { id: a.id, version: 1, comment: "" }))).rejects.toMatchObject({ code: "validation_error" });
    await tx((t) => rejectAdjustment(t, mgr, { id: a.id, version: 1, comment: "recount first" }));
    await tx((t) => submitAdjustment(t, w.ctx, { id: a.id, version: 2 }));
    expect((await tx((t) => approveAdjustment(t, owner, { id: a.id, version: 3 }))).status).toBe("approved");
  });

  test("apply can't go negative (INV-003) or take reserved units (I-07 → reserved_conflict)", async () => {
    const v = await newVariant();
    await stock(v.id, 5);
    const r = await tx((t) => reserve(t, w.ctx, { variantId: v.id, warehouseId: w.warehouse.id, qty: 3 }));
    const a = await submitted("adjustment", [{ variantId: v.id, qty: -3 }]);
    await tx((t) => approveAdjustment(t, mgr, { id: a.id, version: 1 }));
    await expect(tx((t) => applyAdjustment(t, mgr, { id: a.id, version: 2 }))).rejects.toMatchObject({ code: "reserved_conflict" });
    const b = await submitted("adjustment", [{ variantId: v.id, qty: -6 }]);
    await tx((t) => approveAdjustment(t, mgr, { id: b.id, version: 1 }));
    await expect(tx((t) => applyAdjustment(t, mgr, { id: b.id, version: 2 }))).rejects.toMatchObject({ code: "insufficient_stock" });
    await tx((t) => cancel(t, w.ctx, { reservationId: r.reservation.id, version: 0 }));
    await tx((t) => applyAdjustment(t, mgr, { id: a.id, version: 2 }));
    expect(await buckets(v.id)).toEqual(["2", "0"]);
  });
});

describe("damage / repair / disposal (flows 17, 27, 28)", () => {
  test("damage → repair → damage → dispose; each applies on approval at current WAC", async () => {
    const v = await newVariant();
    await stock(v.id, 10, 7);
    const d = await submitted("damage", [{ variantId: v.id, qty: 4 }], "dropped");
    const da = await tx((t) => approveAdjustment(t, mgr, { id: d.id, version: 1 }));
    expect(da.status).toBe("applied");
    expect(await buckets(v.id)).toEqual(["6", "4"]);
    const r = await submitted("repair", [{ variantId: v.id, qty: 1 }], "repaired");
    await tx((t) => approveAdjustment(t, mgr, { id: r.id, version: 1 }));
    expect(await buckets(v.id)).toEqual(["7", "3"]);
    await expect(tx((t) => createAdjustment(t, w.ctx, { kind: "disposal", warehouseId: w.warehouse.id, reasonCode: "scrap", lines: [{ variantId: v.id, qty: 1 }] })))
      .rejects.toMatchObject({ code: "validation_error", details: { field: "bucket" } });
    const x = await submitted("disposal", [{ variantId: v.id, qty: 3, bucket: "damaged" }], "scrap");
    await tx((t) => approveAdjustment(t, mgr, { id: x.id, version: 1 }));
    expect(await buckets(v.id)).toEqual(["7", "0"]);
    const loss = await db.inventoryMovement.findFirstOrThrow({ where: { sourceId: x.id } });
    expect([loss.type, loss.dDamaged.toString(), loss.valueDelta.toString()]).toEqual(["disposal", "-3", "-21"]);
    // too much damaged → insufficient_stock at approval; nothing posted
    const y = await submitted("disposal", [{ variantId: v.id, qty: 1, bucket: "damaged" }], "scrap");
    await expect(tx((t) => approveAdjustment(t, mgr, { id: y.id, version: 1 }))).rejects.toMatchObject({ code: "insufficient_stock" });
  });

  test("edge #31: damage marking can't take reserved units", async () => {
    const v = await newVariant();
    await stock(v.id, 2);
    const r = await tx((t) => reserve(t, w.ctx, { variantId: v.id, warehouseId: w.warehouse.id, qty: 2 }));
    const d = await submitted("damage", [{ variantId: v.id, qty: 1 }], "dropped");
    await expect(tx((t) => approveAdjustment(t, mgr, { id: d.id, version: 1 }))).rejects.toMatchObject({ code: "reserved_conflict" });
    await tx((t) => cancel(t, w.ctx, { reservationId: r.reservation.id, version: 0 }));
  });

  test("serialized: units are named, their status follows (I-06)", async () => {
    const v = await newVariant({ isSerialized: true });
    await stock(v.id, 2, 50, true);
    await db.serialUnit.createMany({ data: ["A1", "A2"].map((serialNo) => ({ companyId: w.company.id, variantId: v.id, serialNo, status: "in_stock" as const, warehouseId: w.warehouse.id, binId: main })) });
    await expect(tx((t) => createAdjustment(t, w.ctx, { kind: "adjustment", warehouseId: w.warehouse.id, reasonCode: "x", lines: [{ variantId: v.id, qty: -1 }] })))
      .rejects.toMatchObject({ code: "validation_error" }); // serialized found/loss → stock count (Part 8)
    const d = await submitted("damage", [{ variantId: v.id, qty: 1, serials: ["A2"] }], "cracked");
    await tx((t) => approveAdjustment(t, mgr, { id: d.id, version: 1 }));
    const x = await submitted("disposal", [{ variantId: v.id, qty: 1, bucket: "damaged", serials: ["A2"] }], "scrap");
    await tx((t) => approveAdjustment(t, mgr, { id: x.id, version: 1 }));
    expect(Object.fromEntries((await db.serialUnit.findMany({ where: { variantId: v.id } })).map((u) => [u.serialNo, u.status]))).toEqual({ A1: "in_stock", A2: "disposed" });
    expect(await buckets(v.id)).toEqual(["1", "0"]);
  });
});

describe("approvals inbox (doc 25)", () => {
  test("lists what the user may decide (not their own), oldest first, and decides through it", async () => {
    const v = await newVariant();
    await stock(v.id, 5);
    const a = await submitted("damage", [{ variantId: v.id, qty: 1 }], "dropped");
    const mine = await listInbox(w.ctx);
    expect(mine.items.find((i) => i.id === a.id)).toBeUndefined(); // creator ≠ approver
    const inbox = await listInbox(mgr);
    const item = inbox.items.find((i) => i.id === a.id)!;
    expect(item).toMatchObject({ type: "stock_adjustment", number: a.number, amount: "10.00", overdue: false, overLimit: false });
    expect(inbox.slaHours).toBe(48);
    await tx((t) => decide(t, mgr, { type: item.type, id: item.id, version: item.version, approve: true }));
    expect((await listInbox(mgr)).items.find((i) => i.id === a.id)).toBeUndefined();
    expect(await buckets(v.id)).toEqual(["4", "1"]);
    // a stale inbox row (someone else decided) → version_conflict
    await expect(tx((t) => decide(t, owner, { type: item.type, id: item.id, version: item.version, approve: false, comment: "late" })))
      .rejects.toMatchObject({ code: "version_conflict" });
  });
});
