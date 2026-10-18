import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { z } from "zod";
import { Prisma, type WebhookEndpoint, type WebhookEvent } from "@/generated/prisma/client";
import { writeAudit } from "@/server/core/audit";
import { requirePermission, type Ctx } from "@/server/core/ctx";
import { AppError, assertVersion } from "@/server/core/errors";
import { db, transaction, type Tx } from "@/server/db";
import { notify } from "@/server/notifications/notify";

// Part 11 T11.4 outbound webhooks (doc 24 "Webhooks — build decisions", doc 26).
// emit() writes the outbox in the caller's transaction; deliverWebhooks() (worker, every
// minute) sends, retries with backoff and keeps the delivery log.

export const EVENT_TYPES = ["stock.low", "stock.out", "reservation.expired", "po.approved", "transfer.received"] as const;
export type EventType = (typeof EVENT_TYPES)[number];

const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000]; // then failed (6 attempts)
const DISABLE_AFTER = 15; // consecutive failed attempts
const TIMEOUT_MS = 10_000;
const LEASE_MS = 2 * 60_000;
const MANAGE = "webhooks.manage";

// ───────────── Outbox ─────────────

// One event row + one delivery per subscribed active endpoint, in the business tx.
// Nothing subscribed → nothing written.
export async function emit(tx: Tx, ctx: Pick<Ctx, "companyId">, type: EventType, data: Record<string, unknown>) {
  const endpoints = await tx.webhookEndpoint.findMany({
    where: { companyId: ctx.companyId, status: "active", events: { has: type } }, select: { id: true },
  });
  if (!endpoints.length) return null;
  const ev = await tx.webhookEvent.create({ data: { companyId: ctx.companyId, type, payload: JSON.parse(JSON.stringify(data)) } });
  await tx.webhookDelivery.createMany({ data: endpoints.map((e) => ({ companyId: ctx.companyId, eventId: ev.id, endpointId: e.id })) });
  return ev.id;
}

// Does the company have an active stock.low / stock.out endpoint? (PostInput.stockHooks)
export const hasStockHooks = async (tx: Tx, companyId: string) =>
  (await tx.webhookEndpoint.count({ where: { companyId, status: "active", events: { hasSome: ["stock.low", "stock.out"] } } })) > 0;

// stock.low / stock.out, edge-triggered on warehouse-level available (doc 24). Called by
// postMovements with each leg's change of available (Δon_hand − Δreserved), after the
// balances are written in this tx. Only decreases can cross a threshold downwards.
export async function emitStockLevels(
  tx: Tx, ctx: Pick<Ctx, "companyId">,
  changes: { variantId: string; warehouseId: string; delta: Prisma.Decimal }[],
  source: { sourceType: string; sourceId: string },
  subscribed?: boolean, // precomputed by hot paths (reserve) before their locks; omitted → checked here
) {
  if (subscribed === false) return;
  const sum = new Map<string, { variantId: string; warehouseId: string; delta: Prisma.Decimal }>();
  for (const c of changes) {
    const k = `${c.variantId}|${c.warehouseId}`;
    const e = sum.get(k);
    sum.set(k, e ? { ...e, delta: e.delta.plus(c.delta) } : { ...c });
  }
  const drops = [...sum.values()].filter((c) => c.delta.lt(0));
  if (!drops.length) return;
  if (subscribed === undefined && !(await hasStockHooks(tx, ctx.companyId))) return;
  const rows = await tx.$queryRaw<{ variant_id: string; warehouse_id: string; sku: string; code: string; available: Prisma.Decimal; reorder_point: Prisma.Decimal | null }[]>`
    SELECT k.v AS variant_id, k.w AS warehouse_id, pv.sku, wh.code, s.reorder_point,
      COALESCE((SELECT SUM(b.on_hand) FROM stock_balance b WHERE b.variant_id = k.v AND b.warehouse_id = k.w), 0)
      - COALESCE((SELECT SUM(a.qty_reserved) FROM stock_allocation a WHERE a.variant_id = k.v AND a.warehouse_id = k.w), 0) AS available
    FROM unnest(${drops.map((d) => d.variantId)}::text[], ${drops.map((d) => d.warehouseId)}::text[]) AS k(v, w)
    JOIN product_variant pv ON pv.id = k.v AND pv.company_id = ${ctx.companyId}
    JOIN warehouse wh ON wh.id = k.w
    LEFT JOIN variant_warehouse_settings s ON s.variant_id = k.v AND s.warehouse_id = k.w`;
  for (const r of rows) {
    const after = new Prisma.Decimal(r.available);
    const before = after.minus(sum.get(`${r.variant_id}|${r.warehouse_id}`)!.delta);
    const rp = r.reorder_point == null ? null : new Prisma.Decimal(r.reorder_point);
    const type: EventType | null = before.gt(0) && after.lte(0) ? "stock.out"
      : rp && after.gt(0) && after.lte(rp) && before.gt(rp) ? "stock.low" : null;
    if (!type) continue;
    await emit(tx, ctx, type, {
      variantId: r.variant_id, sku: r.sku, warehouseId: r.warehouse_id, warehouseCode: r.code,
      available: after, availableBefore: before, reorderPoint: rp, ...source,
    });
  }
}

// ───────────── Signing ─────────────

export const sign = (secret: string, timestamp: number, body: string) =>
  `v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;

// For receivers (and tests): constant-time compare + 5-minute timestamp tolerance.
export function verifySignature(secret: string, headers: { timestamp: string; signature: string }, body: string, now = Date.now()) {
  const ts = Number(headers.timestamp);
  if (!Number.isInteger(ts) || Math.abs(now / 1000 - ts) > 300) return false;
  const want = Buffer.from(sign(secret, ts, body)), got = Buffer.from(headers.signature);
  return want.length === got.length && timingSafeEqual(want, got);
}

// ───────────── SSRF guard (doc 26) ─────────────

const BLOCKED = new net.BlockList();
for (const [a, p] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) BLOCKED.addSubnet(a, p, "ipv4");
for (const [a, p] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) BLOCKED.addSubnet(a, p, "ipv6");

export function isBlockedAddress(ip: string) {
  const v4 = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1]; // IPv4-mapped IPv6
  if (v4 || net.isIPv4(ip)) return BLOCKED.check(v4 ?? ip, "ipv4");
  return BLOCKED.check(ip, "ipv6");
}

const strictDefault = () => process.env.NODE_ENV === "production";

// Save-time check: scheme + literal / localhost hosts. Resolved addresses are checked at connect.
export function checkUrl(raw: string, strict = strictDefault()): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new AppError("validation_error", "Not a valid URL", { field: "url" }); }
  if (u.protocol !== "https:" && (strict || u.protocol !== "http:")) {
    throw new AppError("validation_error", strict ? "Webhook URLs must use https" : "Webhook URLs must use http(s)", { field: "url", reason: "scheme" });
  }
  if (u.username || u.password) throw new AppError("validation_error", "No credentials in the URL", { field: "url" });
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (strict && (host === "localhost" || host.endsWith(".localhost") || (net.isIP(host) && isBlockedAddress(host)))) {
    throw new AppError("validation_error", "Webhook URL points to a private or loopback address", { field: "url", reason: "private_address" });
  }
  return u;
}

// dns.lookup that refuses blocked addresses, used by the socket itself (no rebinding gap).
const guardedLookup: net.LookupFunction = (hostname, options, cb) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err, "", 4);
    const bad = addrs.find((a) => isBlockedAddress(a.address));
    if (bad) return cb(Object.assign(new Error(`Blocked address ${bad.address}`), { code: "EBLOCKED" }), "", 4);
    if (options.all) return (cb as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, addrs);
    cb(null, addrs[0].address, addrs[0].family);
  });
};

type SendResult = { ok: boolean; status?: number; error?: string };

// node:http(s) rather than fetch: only a custom `lookup` lets us vet the address actually
// connected to (doc 26). Redirects aren't followed; the body is discarded.
export function send(url: string, secret: string, body: string, eventId: string, strict = strictDefault()): Promise<SendResult> {
  return new Promise((resolve) => {
    let u: URL;
    try { u = checkUrl(url, strict); } catch (e) { return resolve({ ok: false, error: (e as Error).message }); }
    const ts = Math.floor(Date.now() / 1000);
    const req = (u.protocol === "https:" ? https : http).request(u, {
      method: "POST", timeout: TIMEOUT_MS, ...(strict ? { lookup: guardedLookup } : {}),
      headers: {
        "content-type": "application/json", "user-agent": "inventory-webhooks/1",
        "webhook-id": eventId, "webhook-timestamp": String(ts), "webhook-signature": sign(secret, ts, body),
      },
    }, (res) => {
      res.resume();
      const status = res.statusCode ?? 0;
      resolve(status >= 200 && status < 300 ? { ok: true, status } : { ok: false, status, error: `HTTP ${status}` });
    });
    req.on("timeout", () => req.destroy(new Error(`Timed out after ${TIMEOUT_MS / 1000} s`)));
    req.on("error", (e) => resolve({ ok: false, error: e.message }));
    req.end(body);
  });
}

// ───────────── Delivery (worker) ─────────────

// The exact body (doc 24); rebuilt identically on every retry.
export const body = (e: WebhookEvent) =>
  JSON.stringify({ id: e.id, type: e.type, created_at: e.createdAt.toISOString(), company_id: e.companyId, data: e.payload });

type RunOpts = { companyId?: string; asOf?: Date; limit?: number; strict?: boolean };

// Due deliveries, 10 at a time. Each is claimed with a lease first (two workers never send
// the same one; a crash mid-request retries it after the lease), then sent, then recorded.
export async function deliverWebhooks(opts: RunOpts = {}) {
  const asOf = opts.asOf ?? new Date();
  const due = await db.webhookDelivery.findMany({
    where: { companyId: opts.companyId, status: "pending", nextAttemptAt: { lte: asOf } },
    orderBy: { nextAttemptAt: "asc" }, take: opts.limit ?? 200, select: { id: true, nextAttemptAt: true },
  });
  let delivered = 0, failed = 0;
  for (let i = 0; i < due.length; i += 10) {
    // ponytail: 10 in flight; per-endpoint concurrency limits if one slow receiver starves the rest.
    const results = await Promise.all(due.slice(i, i + 10).map((d) => deliverOne(d.id, d.nextAttemptAt, asOf, opts.strict)));
    delivered += results.filter((r) => r === true).length;
    failed += results.filter((r) => r === false).length;
  }
  return { delivered, failed };
}

async function deliverOne(id: string, seen: Date, asOf: Date, strict?: boolean): Promise<boolean | null> {
  const claimed = await db.webhookDelivery.updateMany({
    where: { id, status: "pending", nextAttemptAt: seen }, data: { nextAttemptAt: new Date(asOf.getTime() + LEASE_MS) },
  });
  if (!claimed.count) return null; // another worker has it
  const d = await db.webhookDelivery.findUniqueOrThrow({ where: { id }, include: { event: true, endpoint: true } });
  if (d.endpoint.status !== "active") {
    await db.webhookDelivery.update({ where: { id }, data: { status: "failed", lastError: "Endpoint disabled" } });
    return false;
  }
  const r = await send(d.endpoint.url, d.endpoint.secret, body(d.event), d.eventId, strict);
  const attempts = d.attempts + 1;
  await transaction(async (tx) => {
    if (r.ok) {
      await tx.webhookDelivery.update({ where: { id }, data: { status: "delivered", attempts, lastStatusCode: r.status, lastError: null, deliveredAt: asOf } });
      await tx.webhookEndpoint.update({ where: { id: d.endpointId }, data: { consecutiveFailures: 0 } });
      return;
    }
    const last = attempts > BACKOFF_MS.length;
    await tx.webhookDelivery.update({
      where: { id },
      data: {
        attempts, lastStatusCode: r.status ?? null, lastError: r.error?.slice(0, 500) ?? null,
        ...(last ? { status: "failed" } : { nextAttemptAt: new Date(asOf.getTime() + BACKOFF_MS[attempts - 1]) }),
      },
    });
    const ep = await tx.webhookEndpoint.update({ where: { id: d.endpointId }, data: { consecutiveFailures: { increment: 1 } } });
    if (ep.status === "active" && ep.consecutiveFailures >= DISABLE_AFTER) await autoDisable(tx, ep);
  });
  return r.ok;
}

async function autoDisable(tx: Tx, ep: WebhookEndpoint) {
  const system = await tx.user.findFirstOrThrow({ where: { companyId: ep.companyId, isSystem: true }, select: { id: true } });
  const ctx = { companyId: ep.companyId, userId: system.id, requestId: crypto.randomUUID(), channel: "system" as const };
  await tx.webhookEndpoint.update({ where: { id: ep.id }, data: { status: "disabled", disabledReason: "too_many_failures", version: { increment: 1 } } });
  await tx.webhookDelivery.updateMany({ where: { endpointId: ep.id, status: "pending" }, data: { status: "failed", lastError: "Endpoint disabled" } });
  await writeAudit(tx, ctx, {
    action: "webhook.disable", entityType: "webhook_endpoint", entityId: ep.id,
    before: { status: "active" }, after: { status: "disabled" }, reason: "too_many_failures",
  });
  await notify(tx, ctx, {
    type: "webhook.disabled", entityType: "webhook_endpoint", entityId: ep.id, permission: MANAGE, link: `/admin/webhooks/${ep.id}`,
    message: `Webhook ${ep.url} disabled after ${DISABLE_AFTER} failed deliveries in a row`,
  });
}

// ───────────── Endpoint management (webhooks.manage, company-wide) ─────────────

const Events = z.array(z.enum(EVENT_TYPES)).min(1, "Pick at least one event").transform((e) => [...new Set(e)]);
const EndpointInput = z.object({
  url: z.string().trim().max(2000),
  description: z.string().trim().max(200).nullish().transform((d) => d || null),
  events: Events,
});

const newSecret = () => `whsec_${randomBytes(32).toString("base64url")}`;
// The secret never leaves after create / rotate.
const view = (e: WebhookEndpoint): Omit<WebhookEndpoint, "secret"> => { const { secret, ...rest } = e; void secret; return rest; };

export async function createEndpoint(tx: Tx, ctx: Ctx, input: z.input<typeof EndpointInput>) {
  await requirePermission(ctx, MANAGE);
  const data = EndpointInput.parse(input);
  checkUrl(data.url);
  const secret = newSecret();
  const ep = await tx.webhookEndpoint.create({ data: { ...data, companyId: ctx.companyId, secret, createdBy: ctx.userId } });
  await writeAudit(tx, ctx, { action: "webhook.create", entityType: "webhook_endpoint", entityId: ep.id, after: view(ep) });
  return { endpoint: view(ep), secret };
}

async function findEndpoint(tx: Tx | typeof db, ctx: Ctx, id: string) {
  const ep = await tx.webhookEndpoint.findFirst({ where: { id, companyId: ctx.companyId } });
  if (!ep) throw new AppError("not_found", "Webhook endpoint not found");
  return ep;
}

async function change(tx: Tx, ctx: Ctx, input: { id: string; version: number }, action: string, data: Prisma.WebhookEndpointUpdateManyMutationInput) {
  await requirePermission(ctx, MANAGE);
  const before = await findEndpoint(tx, ctx, input.id);
  assertVersion(await tx.webhookEndpoint.updateMany({
    where: { id: before.id, companyId: ctx.companyId, version: input.version }, data: { ...data, version: { increment: 1 } },
  }), "Webhook endpoint", before.version);
  const after = await findEndpoint(tx, ctx, input.id);
  await writeAudit(tx, ctx, { action, entityType: "webhook_endpoint", entityId: after.id, before: view(before), after: view(after) });
  return after;
}

export async function updateEndpoint(tx: Tx, ctx: Ctx, input: { id: string; version: number } & z.input<typeof EndpointInput>) {
  const data = EndpointInput.parse(input);
  checkUrl(data.url);
  return view(await change(tx, ctx, input, "webhook.update", data));
}

export async function rotateSecret(tx: Tx, ctx: Ctx, input: { id: string; version: number }) {
  const secret = newSecret();
  const ep = await change(tx, ctx, input, "webhook.rotate", { secret });
  return { endpoint: view(ep), secret };
}

// Re-enabling resets the failure counter; deliveries failed meanwhile are not resent (doc 24).
export async function setEndpointStatus(tx: Tx, ctx: Ctx, input: { id: string; version: number; active: boolean }) {
  const data = input.active
    ? { status: "active", consecutiveFailures: 0, disabledReason: null }
    : { status: "disabled", disabledReason: "by_user" };
  const ep = await change(tx, ctx, input, input.active ? "webhook.enable" : "webhook.disable", data);
  if (!input.active) await tx.webhookDelivery.updateMany({ where: { endpointId: ep.id, status: "pending" }, data: { status: "failed", lastError: "Endpoint disabled" } });
  return view(ep);
}

export async function listEndpoints(ctx: Ctx) {
  await requirePermission(ctx, MANAGE);
  const rows = await db.webhookEndpoint.findMany({ where: { companyId: ctx.companyId }, orderBy: { createdAt: "asc" } });
  return rows.map(view);
}

export async function getEndpoint(ctx: Ctx, id: string) {
  await requirePermission(ctx, MANAGE);
  const ep = await findEndpoint(db, ctx, id);
  const deliveries = await db.webhookDelivery.findMany({
    where: { endpointId: ep.id, companyId: ctx.companyId }, orderBy: { createdAt: "desc" }, take: 50,
    include: { event: { select: { type: true, createdAt: true } } },
  });
  return { endpoint: view(ep), deliveries };
}

