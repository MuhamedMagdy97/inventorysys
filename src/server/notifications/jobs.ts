import type { Notification } from "@/generated/prisma/client";
import { listInbox } from "@/server/approvals/inbox";
import { buildCtx } from "@/server/auth/session-ctx";
import { inScope, type Ctx } from "@/server/core/ctx";
import { db, transaction } from "@/server/db";
import { systemCtx } from "@/server/inventory/jobs";
import { utcToday } from "@/server/inventory/reservations";
import { lowStockRows } from "@/server/reports/reports";
import { readSettings } from "@/server/settings/settings";
import { flushOutbox } from "./email";
import { CATEGORIES, categoryOf, notify } from "./notify";

// Doc 17 jobs (run by src/worker, re-runnable): instant emails, daily digest, daily stock
// alerts (N-03 digest events), approval SLA reminder + escalation (N-04). `companyId`
// narrows a run to one tenant (tests); `asOf` fixes "now".

type RunOpts = { companyId?: string; asOf?: Date };
const companies = (o: RunOpts) => db.company.findMany({ where: { id: o.companyId }, select: { id: true } });
const appUrl = () => process.env.BETTER_AUTH_URL ?? "http://localhost:3000";

// Who may receive a row: its user, or (broadcast) everyone whose scope covers the
// warehouse and who holds the row's grant — the same rule as the center (N-02).
type Recipient = { id: string; email: string; emailCategories: string[]; ctx: Ctx };
async function recipients(companyId: string): Promise<Recipient[]> {
  const users = await db.user.findMany({
    where: { companyId, status: "active", isService: false, isSystem: false },
    select: { id: true, email: true, emailCategories: true },
  });
  const out: Recipient[] = [];
  // ponytail: one ctx build per user per run; batch the role/scope query if a company has thousands of users.
  for (const u of users) out.push({ ...u, ctx: await buildCtx(u.id, { requestId: crypto.randomUUID(), channel: "system" }) });
  return out;
}
const sees = (r: Recipient, n: Pick<Notification, "userId" | "warehouseId" | "permission">) =>
  n.userId ? n.userId === r.id : (!n.warehouseId || inScope(r.ctx, n.warehouseId)) && (!n.permission || r.ctx.permissions.has(n.permission));
const line = (n: Pick<Notification, "message" | "link">) => `- ${n.message}${n.link ? ` — ${appUrl()}${n.link}` : ""}`;

const DIGEST_TYPES = Object.entries(CATEGORIES).filter(([, c]) => c.mode === "digest").map(([k]) => k);
const isDigest = (type: string) => DIGEST_TYPES.includes(categoryOf(type));

// N-03 instant (approvals, discrepancies, document updates): every minute, one email per
// notification to each recipient who opted into its category. One transaction per row;
// `emailed_at` is claimed first, so a re-run never emails twice.
export async function sendInstantEmails(opts: RunOpts & { limit?: number } = {}) {
  const asOf = opts.asOf ?? new Date();
  let emails = 0;
  for (const c of await companies(opts)) {
    const rows = (await db.notification.findMany({
      where: { companyId: c.id, emailedAt: null, createdAt: { lte: asOf } }, orderBy: { id: "asc" }, take: opts.limit ?? 500,
    })).filter((n) => !isDigest(n.type));
    if (!rows.length) continue;
    const people = await recipients(c.id);
    for (const n of rows) {
      emails += await transaction(async (tx) => {
        const claimed = await tx.notification.updateMany({ where: { id: n.id, emailedAt: null }, data: { emailedAt: asOf } });
        if (!claimed.count) return 0;
        const to = people.filter((r) => r.emailCategories.includes(categoryOf(n.type)) && sees(r, n));
        await tx.emailOutbox.createMany({
          data: to.map((r) => ({ companyId: c.id, userId: r.id, toEmail: r.email, kind: "instant", subject: n.message.slice(0, 150), body: `${line(n)}\n`, notificationIds: [n.id] })),
        });
        return to.length;
      });
    }
  }
  return { emails, ...(await flushOutbox()) };
}

// N-03 digest (low stock, expiring, reservation expiry): daily, one email per recipient
// with everything they may see since the last digest.
export async function sendDigests(opts: RunOpts = {}) {
  const asOf = opts.asOf ?? new Date();
  let emails = 0;
  for (const c of await companies(opts)) {
    emails += await transaction(async (tx) => {
      const rows = (await tx.notification.findMany({ where: { companyId: c.id, emailedAt: null, createdAt: { lte: asOf } }, orderBy: { id: "asc" } }))
        .filter((n) => isDigest(n.type));
      if (!rows.length) return 0;
      await tx.notification.updateMany({ where: { id: { in: rows.map((n) => n.id) }, emailedAt: null }, data: { emailedAt: asOf } });
      let sent = 0;
      for (const r of await recipients(c.id)) {
        const mine = rows.filter((n) => r.emailCategories.includes(categoryOf(n.type)) && sees(r, n));
        if (!mine.length) continue;
        await tx.emailOutbox.create({
          data: {
            companyId: c.id, userId: r.id, toEmail: r.email, kind: "digest", notificationIds: mine.map((n) => n.id),
            subject: `Inventory digest: ${mine.length} update(s)`,
            body: `${mine.slice(0, 200).map(line).join("\n")}${mine.length > 200 ? `\n…and ${mine.length - 200} more in the app` : ""}\n`,
          },
        });
        sent++;
      }
      return sent;
    });
  }
  return { emails, ...(await flushOutbox()) };
}

const REPORT_GRANTS: ReadonlySet<string> = new Set(["reports.view", "inventory.view"]);

// Doc 17 §1 low / out of stock + expiring: once a day per warehouse, one summary row per
// event kind (the digest carries it). Skips a warehouse already alerted today (re-runs).
export async function stockAlerts(opts: RunOpts = {}) {
  const asOf = opts.asOf ?? new Date();
  const today = utcToday(asOf);
  let created = 0;
  for (const c of await companies(opts)) {
    const ctx: Ctx = { ...(await systemCtx(c.id)), permissions: REPORT_GRANTS };
    const { expiryAlertDays } = await readSettings(db, c.id);
    const horizon = new Date(today.getTime() + expiryAlertDays * 86_400_000);
    const low = await lowStockRows(ctx, {});
    const expiring = await db.stockBalance.groupBy({
      by: ["warehouseId"], _count: { _all: true }, _sum: { onHand: true },
      where: { companyId: c.id, onHand: { gt: 0 }, batch: { expiryDate: { gte: today, lte: horizon } } },
    });
    const warehouses = await db.warehouse.findMany({ where: { companyId: c.id, status: { not: "archived" } }, select: { id: true, code: true } });
    for (const w of warehouses) {
      const out = low.filter((r) => r.warehouseId === w.id && r.status === "out").length;
      const lo = low.filter((r) => r.warehouseId === w.id && r.status === "low").length;
      const exp = expiring.find((e) => e.warehouseId === w.id);
      const events = [
        out && { type: "stock.out", message: `${w.code}: ${out} item(s) out of stock`, link: `/reports/low-stock?warehouseId=${w.id}` },
        lo && { type: "stock.low", message: `${w.code}: ${lo} item(s) at or below reorder point`, link: `/reports/low-stock?warehouseId=${w.id}` },
        exp && { type: "batch.expiring", message: `${w.code}: ${exp._count._all} batch position(s), ${exp._sum.onHand?.toString()} unit(s), expire within ${expiryAlertDays} days`, link: `/reports/summary?warehouseId=${w.id}` },
      ].filter((e) => !!e);
      for (const e of events) {
        const done = await db.notification.count({ where: { companyId: c.id, type: e.type, entityId: w.id, createdAt: { gte: today } } });
        if (done) continue;
        await transaction((tx) => notify(tx, ctx, { ...e, entityType: "warehouse", entityId: w.id, warehouseId: w.id, permission: "inventory.view" }));
        created++;
      }
    }
  }
  return { created };
}

const APPROVE_GRANTS: ReadonlySet<string> = new Set([
  "purchases.approve", "purchases.return_approve", "sales.return_approve", "inventory.transfer_approve", "inventory.adjust_approve", "inventory.adjust_apply",
  "inventory.damage_approve", "inventory.repair_approve", "inventory.dispose_approve", "inventory.count_approve", "inventory.count_apply",
]);

// N-04: an approval waiting ≥ half the SLA → reminder to everyone who can decide it (its
// grant, its warehouse); ≥ the SLA → escalation to each Owner (Super Admins when the
// company has no Owner). Once per waiting period (a re-submitted document starts over).
export async function escalateApprovals(opts: RunOpts = {}) {
  const asOf = opts.asOf ?? new Date();
  let reminders = 0, escalations = 0;
  for (const c of await companies(opts)) {
    const ctx: Ctx = { ...(await systemCtx(c.id)), permissions: APPROVE_GRANTS, limits: new Map() };
    const { items, slaHours } = await listInbox(ctx);
    const owners = await ownersOf(c.id);
    for (const i of items) {
      const age = (asOf.getTime() - i.waitingSince.getTime()) / 3_600_000;
      const since = { companyId: c.id, entityId: i.id, createdAt: { gte: i.waitingSince } };
      const base = { entityType: i.type, entityId: i.id, link: i.link };
      if (age >= slaHours / 2 && !(await db.notification.count({ where: { ...since, type: "approval.reminder" } }))) {
        await transaction((tx) => notify(tx, ctx, {
          ...base, type: "approval.reminder", warehouseId: i.warehouseId, permission: i.grant,
          message: `Reminder: ${i.number} (${i.summary}) has waited ${Math.floor(age)} h for approval`,
        }));
        reminders++;
      }
      if (age >= slaHours && !(await db.notification.count({ where: { ...since, type: "approval.escalated" } }))) {
        await transaction(async (tx) => {
          for (const o of owners) {
            await notify(tx, ctx, { ...base, type: "approval.escalated", userId: o, message: `Escalated: ${i.number} (${i.summary}) is past the ${slaHours} h approval SLA` });
          }
        });
        escalations++;
      }
    }
  }
  return { reminders, escalations };
}

async function ownersOf(companyId: string) {
  for (const code of ["owner", "super_admin"]) {
    const us = await db.userRole.findMany({ where: { companyId, role: { code }, user: { status: "active" } }, select: { userId: true } });
    if (us.length) return us.map((u) => u.userId);
  }
  return [];
}
