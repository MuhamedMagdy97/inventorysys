import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { buildCtx } from "@/server/auth/session-ctx";
import type { Ctx } from "@/server/core/ctx";
import { db, transaction } from "@/server/db";
import { createAdjustment, submitAdjustment } from "@/server/inventory/adjustments";
import { postMovements } from "@/server/inventory/post";
import { createLoginUser, seedCompany } from "@/server/seed";
import { createWarehouse } from "@/server/warehouses/warehouses";
import { listNotifications, markRead, setPreferences } from "./center";
import { setEmailTransport } from "./email";
import { escalateApprovals, sendDigests, sendInstantEmails, stockAlerts } from "./jobs";
import { categoryOf, notify } from "./notify";

// Part 9 T9.3: center visibility (scope + grant, per-user read state), instant + digest
// email with opt-in, daily stock alerts, approval SLA reminder → escalation (N-01…04).

let w: Awaited<ReturnType<typeof seedCompany>>;
let A: string, B: string;
let aStaff: Ctx, bStaff: Ctx, owner: Ctx;
const companyId = () => w.company.id;

async function userCtx(role: string, warehouseIds: string[] = []) {
  const roleId = w.roles.find((r) => r.code === role)!.id;
  const u = await transaction((t) => createLoginUser(t, w.company.id, { name: role, email: `${role}+${crypto.randomUUID()}@test.invalid`, password: "x", roleId, warehouseIds }));
  return buildCtx(u.id, { requestId: crypto.randomUUID(), channel: "system" });
}
const say = (n: Parameters<typeof notify>[2]) => transaction((tx) => notify(tx, w.ctx, n));
const outbox = (userId: string) => db.emailOutbox.findMany({ where: { companyId: companyId(), userId }, orderBy: { id: "asc" } });

beforeAll(async () => {
  w = await seedCompany(`ntf-${crypto.randomUUID()}`);
  A = w.warehouse.id;
  B = (await transaction((t) => createWarehouse(t, w.ctx, { code: "WH-B", name: "Branch" }))).id;
  aStaff = await userCtx("warehouse_manager", [A]);
  bStaff = await userCtx("warehouse_manager", [B]);
  owner = await userCtx("owner");
});
afterAll(async () => {
  setEmailTransport(null);
  await db.$disconnect();
});

describe("notification center", () => {
  test("broadcasts follow warehouse scope and grant; read state is per user", async () => {
    const n1 = await say({ type: "transfer.shipped", entityType: "transfer", entityId: "t1", warehouseId: A, message: "to A" });
    await say({ type: "reconcile.drift", entityType: "company", entityId: companyId(), message: "drift", permission: "settings.manage" });
    await say({ type: "adjustment.rejected", entityType: "stock_adjustment", entityId: "x", userId: bStaff.userId, message: "yours" });

    const a = await listNotifications(aStaff, { page: 1, perPage: 50 });
    expect(a.items.map((i) => i.message)).toEqual(["to A"]); // not B's direct row, no settings.manage
    expect((await listNotifications(bStaff, { page: 1, perPage: 50 })).items.map((i) => i.message)).toEqual(["yours"]);
    expect((await listNotifications(owner, { page: 1, perPage: 50 })).items.map((i) => i.message)).toEqual(["drift", "to A"]);

    await transaction((tx) => markRead(tx, aStaff, { ids: [n1.id] }));
    expect((await listNotifications(aStaff, { page: 1, perPage: 50 })).unread).toBe(0);
    expect((await listNotifications(owner, { page: 1, perPage: 50, unreadOnly: true })).total).toBe(2); // still unread for the owner
    await expect(transaction((tx) => markRead(tx, bStaff, { ids: [n1.id] }))).rejects.toMatchObject({ code: "not_found" });
    await transaction((tx) => markRead(tx, owner, {}));
    expect((await listNotifications(owner, { page: 1, perPage: 50 })).unread).toBe(0);
  });

  test("categories map to delivery modes (N-03)", () => {
    expect(["stock.low", "batch.expiring", "reservation.expired", "approval.reminder", "transfer.variance_reported", "transfer.approved"].map(categoryOf))
      .toEqual(["stock", "stock", "reservations", "approvals", "discrepancies", "documents"]);
  });
});

describe("email", () => {
  test("instant: only opted-in recipients who may see the row; never twice; pluggable transport", async () => {
    await sendInstantEmails({ companyId: companyId() }); // drain earlier rows (nobody opted in yet)
    await transaction((tx) => setPreferences(tx, aStaff, { emailCategories: ["documents"] }));
    await transaction((tx) => setPreferences(tx, bStaff, { emailCategories: ["documents", "stock"] }));
    await expect(transaction((tx) => setPreferences(tx, bStaff, { emailCategories: ["nope"] }))).rejects.toThrow();
    const before = (await outbox(aStaff.userId)).length;
    await say({ type: "transfer.approved", entityType: "transfer", entityId: "t2", warehouseId: A, message: "TR approved", link: "/transfers/t2" });
    const sent: string[] = [];
    setEmailTransport(async (m) => { sent.push(m.to); });
    const r = await sendInstantEmails({ companyId: companyId() });
    expect(r.emails).toBe(1);
    const mine = await outbox(aStaff.userId);
    expect(mine).toHaveLength(before + 1);
    expect(mine.at(-1)).toMatchObject({ kind: "instant", subject: "TR approved", status: "sent" });
    expect(mine.at(-1)!.body).toContain("/transfers/t2");
    expect(sent).toHaveLength(1);
    expect(await outbox(bStaff.userId)).toHaveLength(0); // B can't see an A broadcast
    expect((await sendInstantEmails({ companyId: companyId() })).emails).toBe(0);
    setEmailTransport(null);
  });

  test("daily stock alerts → one digest per opted-in user; alerts run once a day", async () => {
    const v = w.variants[0].id;
    const binId = (await db.bin.findFirstOrThrow({ where: { warehouseId: B, code: "MAIN" } })).id;
    await transaction((tx) => postMovements(tx, w.ctx, { sourceType: "test", sourceId: "n-1", legs: [{ type: "purchase_receipt", variantId: v, warehouseId: B, binId, delta: { onHand: 2 }, unitCost: 1, line: 1, reasonCode: "t" }] }));
    await db.variantWarehouseSettings.create({ data: { companyId: companyId(), variantId: v, warehouseId: B, reorderPoint: 5 } });
    expect(await stockAlerts({ companyId: companyId() })).toEqual({ created: 1 });
    expect(await stockAlerts({ companyId: companyId() })).toEqual({ created: 0 });
    expect((await listNotifications(bStaff, { page: 1, perPage: 5 })).items[0]).toMatchObject({ type: "stock.low", warehouseId: B });
    expect((await listNotifications(aStaff, { page: 1, perPage: 50 })).items.some((i) => i.type === "stock.low")).toBe(false);

    expect((await sendInstantEmails({ companyId: companyId() })).emails).toBe(0); // digest types wait for the digest
    expect((await sendDigests({ companyId: companyId() })).emails).toBe(1);
    const d = (await outbox(bStaff.userId)).filter((m) => m.kind === "digest");
    expect(d).toHaveLength(1);
    expect(d[0].body).toContain("WH-B: 1 item(s) at or below reorder point");
    expect((await sendDigests({ companyId: companyId() })).emails).toBe(0);
  });
});

describe("approval SLA (N-04)", () => {
  test("reminder at half the SLA to deciders in scope, escalation to the Owner at the SLA, once each", async () => {
    const a = await transaction((t) => createAdjustment(t, w.ctx, { kind: "adjustment", warehouseId: A, reasonCode: "found", lines: [{ variantId: w.variants[1].id, qty: 1 }] }));
    await transaction((t) => submitAdjustment(t, w.ctx, { id: a.id, version: 0 }));
    const at = (h: number) => new Date(Date.now() + h * 3_600_000);

    expect(await escalateApprovals({ companyId: companyId(), asOf: at(10) })).toEqual({ reminders: 0, escalations: 0 });
    expect(await escalateApprovals({ companyId: companyId(), asOf: at(25) })).toEqual({ reminders: 1, escalations: 0 });
    expect(await escalateApprovals({ companyId: companyId(), asOf: at(30) })).toEqual({ reminders: 0, escalations: 0 });
    expect(await escalateApprovals({ companyId: companyId(), asOf: at(49) })).toEqual({ reminders: 0, escalations: 1 });
    expect(await escalateApprovals({ companyId: companyId(), asOf: at(60) })).toEqual({ reminders: 0, escalations: 0 });

    const reminder = await db.notification.findFirstOrThrow({ where: { companyId: companyId(), type: "approval.reminder", entityId: a.id } });
    expect(reminder).toMatchObject({ warehouseId: A, permission: "inventory.adjust_approve", userId: null });
    const esc = await db.notification.findMany({ where: { companyId: companyId(), type: "approval.escalated", entityId: a.id } });
    expect(esc.map((e) => e.userId)).toEqual([owner.userId]);
    // The reminder reaches deciders only: the owner holds adjust_approve, a warehouse manager doesn't.
    expect((await listNotifications(owner, { page: 1, perPage: 50 })).items.filter((i) => i.entityId === a.id).map((i) => i.type).sort()).toEqual(["approval.escalated", "approval.reminder"]);
    expect((await listNotifications(aStaff, { page: 1, perPage: 50 })).items.some((i) => i.entityId === a.id)).toBe(false);
  });
});
