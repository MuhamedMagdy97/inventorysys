import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { buildCtx } from "@/server/auth/session-ctx";
import type { Ctx } from "@/server/core/ctx";
import { db, transaction } from "@/server/db";
import { expireDueReservations } from "@/server/inventory/jobs";
import { postMovements } from "@/server/inventory/post";
import { reserve } from "@/server/inventory/reservations";
import { createLoginUser, seedCompany } from "@/server/seed";
import { checkUrl, createEndpoint, deliverWebhooks, emit, getEndpoint, isBlockedAddress, listEndpoints, send, setEndpointStatus, verifySignature } from "./webhooks";

// Part 11 T11.4 (doc 24/26): outbox in the posting tx, signed delivery to a local
// receiver, retry/backoff, auto-disable, company scope, SSRF guard.

type Hit = { headers: http.IncomingHttpHeaders; body: string };
const hits: Hit[] = [];
let reply = 200;
let server: http.Server;
let url = "";

let w: Awaited<ReturnType<typeof seedCompany>>;
let other: Awaited<ReturnType<typeof seedCompany>>;
let bin = "";
let n = 0;
const run = (asOf?: Date) => deliverWebhooks({ companyId: w.company.id, asOf, strict: false });

const post = (variantId: string, qty: number, c = w) =>
  transaction((tx) => postMovements(tx, c.ctx, {
    sourceType: "test", sourceId: `t-${++n}`,
    legs: [qty > 0
      ? { type: "opening_balance", variantId, warehouseId: c.warehouse.id, binId: c.warehouse.bins.find((b) => b.code === "MAIN")!.id, delta: { onHand: qty }, unitCost: 1, line: 1, reasonCode: "opening" }
      : { type: "adjustment_out", variantId, warehouseId: c.warehouse.id, binId: c.warehouse.bins.find((b) => b.code === "MAIN")!.id, delta: { onHand: qty }, line: 1, reasonCode: "count" }],
  }));
const events = (companyId = w.company.id) => db.webhookEvent.findMany({ where: { companyId }, orderBy: { id: "asc" } });

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => { hits.push({ headers: req.headers, body }); res.writeHead(reply).end(); });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  w = await seedCompany(`wh-${crypto.randomUUID()}`);
  other = await seedCompany(`wh2-${crypto.randomUUID()}`);
  bin = w.warehouse.bins.find((b) => b.code === "MAIN")!.id;
});
beforeEach(() => { hits.length = 0; reply = 200; });
afterAll(async () => {
  server.close();
  await db.$disconnect();
});

describe("endpoints", () => {
  test("secret shown once; admin grant; company scope; audited", async () => {
    const { endpoint, secret } = await transaction((tx) => createEndpoint(tx, w.ctx, { url, events: ["po.approved"] }));
    expect(secret).toMatch(/^whsec_[\w-]{43}$/);
    expect(endpoint).not.toHaveProperty("secret");
    expect((await listEndpoints(w.ctx)).every((e) => !("secret" in e))).toBe(true);
    const audit = await db.auditLog.findFirstOrThrow({ where: { entityId: endpoint.id, action: "webhook.create" } });
    expect(JSON.stringify(audit.after)).not.toContain(secret);

    const roleId = w.roles.find((r) => r.code === "warehouse_manager")!.id;
    const u = await transaction((t) => createLoginUser(t, w.company.id, { name: "wm", email: `wm+${crypto.randomUUID()}@test.invalid`, password: "x", roleId }));
    const staff: Ctx = await buildCtx(u.id, { requestId: crypto.randomUUID(), channel: "system" });
    await expect(listEndpoints(staff)).rejects.toMatchObject({ code: "forbidden" });
    await expect(getEndpoint(other.ctx, endpoint.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(transaction((tx) => createEndpoint(tx, w.ctx, { url, events: [] }))).rejects.toThrow();
    await transaction((tx) => setEndpointStatus(tx, w.ctx, { id: endpoint.id, version: 0, active: false }));
  });

  test("SSRF guard: https only + no private/loopback addresses in production", async () => {
    for (const bad of ["http://example.com/x", "https://127.0.0.1/x", "https://10.1.2.3/", "https://[::1]/", "https://[::ffff:192.168.1.1]/", "https://localhost/", "https://169.254.169.254/", "ftp://example.com/"]) {
      expect(() => checkUrl(bad, true), bad).toThrow();
    }
    expect(checkUrl("https://example.com/hook", true).hostname).toBe("example.com");
    expect(checkUrl("http://127.0.0.1:3000/hook", false).port).toBe("3000"); // dev/test receivers
    expect(["8.8.8.8", "2606:4700::1111"].map(isBlockedAddress)).toEqual([false, false]);
    expect(["100.64.0.1", "172.31.255.255", "fd00::1", "fe80::1", "0.0.0.0"].map(isBlockedAddress)).toEqual([true, true, true, true, true]);
    // Delivery re-checks: a strict send never reaches the local receiver.
    expect(await send(url, "s", "{}", "e", true)).toMatchObject({ ok: false });
    expect(hits).toHaveLength(0);
  });
});

describe("delivery", () => {
  let secret = "";
  let endpointId = "";
  const v = () => w.variants[0].id;

  beforeAll(async () => {
    const r = await transaction((tx) => createEndpoint(tx, w.ctx, { url, events: ["stock.low", "stock.out", "reservation.expired"] }));
    secret = r.secret;
    endpointId = r.endpoint.id;
  });

  test("stock.out in the posting tx; signed body verifies; idempotent per event id", async () => {
    await post(v(), 5);
    expect(await events()).toHaveLength(0); // up: nothing crosses
    await post(v(), -5);
    const [ev] = await events();
    expect(ev.type).toBe("stock.out");
    expect(await run()).toEqual({ delivered: 1, failed: 0 });
    expect(hits).toHaveLength(1);
    const h = hits[0];
    expect(verifySignature(secret, { timestamp: String(h.headers["webhook-timestamp"]), signature: String(h.headers["webhook-signature"]) }, h.body)).toBe(true);
    expect(verifySignature("whsec_wrong", { timestamp: String(h.headers["webhook-timestamp"]), signature: String(h.headers["webhook-signature"]) }, h.body)).toBe(false);
    const body = JSON.parse(h.body);
    expect(body).toMatchObject({ id: ev.id, type: "stock.out", company_id: w.company.id, data: { variantId: v(), sku: "TSHIRT-RED-M", warehouseId: w.warehouse.id, available: "0", availableBefore: "5" } });
    expect(h.headers["webhook-id"]).toBe(ev.id);
    expect(await run()).toEqual({ delivered: 0, failed: 0 }); // delivered once
  });

  test("stock.low is edge-triggered at the reorder point; reservations count", async () => {
    await db.variantWarehouseSettings.create({ data: { companyId: w.company.id, variantId: v(), warehouseId: w.warehouse.id, reorderPoint: 3 } });
    const before = (await events()).length;
    await post(v(), 10);
    await transaction((tx) => reserve(tx, w.ctx, { variantId: v(), warehouseId: w.warehouse.id, qty: 7 })); // 10 → 3
    await post(v(), -1); // 3 → 2: already low, no new event
    const types = (await events()).slice(before).map((e) => e.type);
    expect(types).toEqual(["stock.low"]);
    await run();
  });

  test("reserve emits stock.out when subscribed (hook precomputed outside the position lock)", async () => {
    const before = (await events()).length;
    await transaction((tx) => reserve(tx, w.ctx, { variantId: v(), warehouseId: w.warehouse.id, qty: 2 })); // available 2 → 0
    const fresh = (await events()).slice(before);
    expect(fresh.map((e) => e.type)).toEqual(["stock.out"]);
    expect(fresh[0].payload).toMatchObject({ sourceType: "reservation", available: "0", availableBefore: "2" });
    await run();
  });

  test("retry on 500 with backoff, same event id; gives up after 6 attempts", async () => {
    await transaction((tx) => emit(tx, w.ctx, "reservation.expired", { reservationId: "r1" }));
    reply = 500;
    const t0 = new Date();
    expect(await run(t0)).toEqual({ delivered: 0, failed: 1 });
    const d = await db.webhookDelivery.findFirstOrThrow({ where: { endpointId, status: "pending" } });
    expect(d).toMatchObject({ attempts: 1, lastStatusCode: 500 });
    expect(d.nextAttemptAt.getTime()).toBe(t0.getTime() + 60_000);
    expect(await run(new Date(t0.getTime() + 30_000))).toEqual({ delivered: 0, failed: 0 }); // not due yet
    reply = 200;
    expect(await run(new Date(t0.getTime() + 61_000))).toEqual({ delivered: 1, failed: 0 });
    expect(hits.map((h) => h.headers["webhook-id"])).toEqual([d.eventId, d.eventId]);
    expect(await db.webhookDelivery.findUniqueOrThrow({ where: { id: d.id } })).toMatchObject({ status: "delivered", attempts: 2 });

    await transaction((tx) => emit(tx, w.ctx, "reservation.expired", { reservationId: "r2" }));
    reply = 503;
    let t = Date.now();
    for (let i = 0; i < 6; i++) { await run(new Date(t)); t += 7 * 3_600_000; }
    const dead = await db.webhookDelivery.findFirstOrThrow({ where: { endpointId }, orderBy: { createdAt: "desc" } });
    expect(dead).toMatchObject({ status: "failed", attempts: 6 });
  });

  test("15 failures in a row disable the endpoint (audit + notification); success resets the count", async () => {
    await db.webhookEndpoint.update({ where: { id: endpointId }, data: { consecutiveFailures: 14 } });
    await transaction((tx) => emit(tx, w.ctx, "reservation.expired", { reservationId: "r3" }));
    await transaction((tx) => emit(tx, w.ctx, "reservation.expired", { reservationId: "r4" }));
    reply = 500;
    await deliverWebhooks({ companyId: w.company.id, strict: false, limit: 1 });
    const ep = await db.webhookEndpoint.findUniqueOrThrow({ where: { id: endpointId } });
    expect(ep).toMatchObject({ status: "disabled", disabledReason: "too_many_failures" });
    expect(await db.webhookDelivery.count({ where: { endpointId, status: "pending" } })).toBe(0);
    expect(await db.auditLog.count({ where: { entityId: endpointId, action: "webhook.disable" } })).toBe(1);
    expect(await db.notification.count({ where: { entityId: endpointId, type: "webhook.disabled" } })).toBe(1);
    // Disabled → nothing new is written.
    expect(await transaction((tx) => emit(tx, w.ctx, "reservation.expired", { reservationId: "r5" }))).toBeNull();
    await transaction((tx) => setEndpointStatus(tx, w.ctx, { id: endpointId, version: ep.version, active: true }));
    expect((await db.webhookEndpoint.findUniqueOrThrow({ where: { id: endpointId } })).consecutiveFailures).toBe(0);
  });

  test("outbox rows roll back with the posting", async () => {
    await post(v(), 50);
    const before = await db.webhookEvent.count({ where: { companyId: w.company.id } });
    const avail = 50; // on hand 59, 9 still reserved by the stock.low + reserve tests
    await expect(transaction(async (tx) => {
      await postMovements(tx, w.ctx, {
        sourceType: "test", sourceId: `t-${++n}`,
        legs: [{ type: "adjustment_out", variantId: v(), warehouseId: w.warehouse.id, binId: bin, delta: { onHand: -avail }, line: 1, reasonCode: "count" }],
      });
      expect(await tx.webhookEvent.count({ where: { companyId: w.company.id } })).toBe(before + 1); // written in the tx…
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    expect(await db.webhookEvent.count({ where: { companyId: w.company.id } })).toBe(before); // …and gone with it
    expect(await db.webhookDelivery.count({ where: { companyId: w.company.id, status: "pending" } })).toBe(0);
  });

  test("reservation.expired from the expiry job; other companies' events never reach this endpoint", async () => {
    const r = await transaction((tx) => reserve(tx, w.ctx, { variantId: v(), warehouseId: w.warehouse.id, qty: 1 }));
    await db.reservation.update({ where: { id: r.reservation.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await expireDueReservations({ companyId: w.company.id });
    const ev = (await events()).at(-1)!;
    expect(ev).toMatchObject({ type: "reservation.expired", payload: { reservationId: r.reservation.id, qtyReleased: "1" } });

    await post(other.variants[0].id, 2, other);
    await post(other.variants[0].id, -2, other); // stock.out in the other company: no endpoint there
    expect(await events(other.company.id)).toHaveLength(0);
    await run();
    expect(hits.every((h) => JSON.parse(h.body).company_id === w.company.id)).toBe(true);
    expect(await db.webhookDelivery.count({ where: { endpointId, event: { companyId: { not: w.company.id } } } })).toBe(0);
  });
});
