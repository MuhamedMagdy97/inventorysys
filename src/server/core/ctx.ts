import type { Prisma, SalesChannel } from "@/generated/prisma/client";
import { db } from "@/server/db";
import { writeAudit } from "./audit";
import { AppError } from "./errors";

// Who is acting, for which company, in which warehouses. Built from the session or
// API key per request (src/server/auth/session-ctx.ts), so permission changes take
// effect on the next request (doc 02 §4, INV-018). Tests and the worker build it directly.
export type Ctx = {
  companyId: string;
  userId: string; // actor_id; the system user for jobs
  warehouseIds: string[] | "all";
  permissions: ReadonlySet<string>;
  // limit_amount per grant (doc 02 §5.1); null or absent = unlimited.
  limits?: ReadonlyMap<string, Prisma.Decimal | null>;
  requestId: string;
  channel?: "web" | "api" | "mobile" | "scan" | "system";
  salesChannel?: SalesChannel; // API-key requests: the service user's channel (SO-06)
  authAt?: Date; // web sessions: when the user last signed in (step-up, doc 26)
};

// Doc 26 step-up: sensitive grants need a sign-in within this window on web sessions.
export const STEP_UP_MINUTES = 30;
const SENSITIVE = new Set([
  "inventory.count_apply", "inventory.adjust_apply", "inventory.receive", "inventory.transfer_ship",
  "inventory.transfer_receive", "purchases.return_ship", "sales.return_receive", "users.manage", "roles.manage",
]);
const isSensitive = (p: string) => SENSITIVE.has(p) || p.endsWith(".approve") || p.endsWith("_approve");

// Only interactive sessions step up (API keys and jobs are exempt), and only when every
// accepted grant is sensitive: a call that also accepts a view grant is a read.
function needsStepUp(ctx: Ctx, grants: string[]) {
  if (ctx.channel !== "web" || !grants.every(isSensitive)) return false;
  return !ctx.authAt || Date.now() - ctx.authAt.getTime() > STEP_UP_MINUTES * 60_000;
}

// The auth guard every domain function calls itself (T2.3): permission (any of) +
// warehouse scope (INV-013) + approval limit (INV-020). A denial is audited as
// `access.denied` on its own connection, so it survives the caller's rollback (A-05).
export async function requirePermission(
  ctx: Ctx,
  grant: string | string[],
  opts: { warehouseId?: string | null; amount?: Prisma.Decimal | string | number } = {},
): Promise<void> {
  const any = Array.isArray(grant) ? grant : [grant];
  const held = any.filter((p) => ctx.permissions.has(p));
  let denial: { message: string; details: Record<string, unknown> } | null = null;

  if (!held.length) {
    denial = { message: `Missing permission ${any.join(" | ")}`, details: { reason: "missing_grant", permission: any } };
  } else if (opts.warehouseId && !inScope(ctx, opts.warehouseId)) {
    denial = { message: "Warehouse out of scope", details: { reason: "out_of_scope", warehouseId: opts.warehouseId } };
  } else if (opts.amount !== undefined) {
    const limits = held.map((p) => ctx.limits?.get(p) ?? null);
    const unlimited = limits.some((l) => l === null);
    const max = limits.reduce<Prisma.Decimal | null>((m, l) => (l && (!m || l.gt(m)) ? l : m), null);
    if (!unlimited && max && max.lt(opts.amount)) {
      denial = { message: "Amount above your approval limit", details: { reason: "over_limit", limit: max.toString(), amount: String(opts.amount) } };
    }
  }
  if (!denial && needsStepUp(ctx, any)) {
    denial = { message: "Please sign in again to confirm this action", details: { reason: "step_up_required", maxAgeMinutes: STEP_UP_MINUTES } };
  }
  if (!denial) return;
  throw await deny(ctx, denial.message, denial.details, { type: "permission", id: any.join("|"), warehouseId: opts.warehouseId });
}

// INV-006 / doc 02 SoD: approver ≠ creator on PO / adjustment / transfer / return.
export async function requireNotCreator(ctx: Ctx, creatorId: string, entity: { type: string; id: string }) {
  if (creatorId === ctx.userId) {
    throw await deny(ctx, "Creator cannot approve their own document", { reason: "creator_is_approver" }, entity);
  }
}

// Audits `access.denied` on its own connection (survives the caller's rollback, A-05)
// and returns the `forbidden` error to throw.
export async function deny(
  ctx: Ctx,
  message: string,
  details: Record<string, unknown>,
  entity: { type: string; id: string; warehouseId?: string | null },
): Promise<AppError> {
  await writeAudit(db, ctx, {
    action: "access.denied", entityType: entity.type, entityId: entity.id,
    warehouseId: entity.warehouseId ?? null, after: details, reason: message,
  }).catch((e) => console.error("access.denied audit failed", e));
  return new AppError("forbidden", message, details);
}

export const inScope = (ctx: Ctx, warehouseId: string) =>
  ctx.warehouseIds === "all" || ctx.warehouseIds.includes(warehouseId);

// Prisma `where.warehouseId` for list queries: the requested warehouse, or the user's scope.
export const scopeFilter = (ctx: Ctx, warehouseId?: string) =>
  warehouseId ?? (ctx.warehouseIds === "all" ? undefined : { in: ctx.warehouseIds });
