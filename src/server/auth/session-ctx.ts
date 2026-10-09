import type { Prisma } from "@/generated/prisma/client";
import type { Ctx } from "@/server/core/ctx";
import { AppError } from "@/server/core/errors";
import { db } from "@/server/db";
import { auth } from "./auth";

// T2.4: the ctx every route handler / Server Action passes to domain functions.
// Rebuilt from the DB on every request, so revoking a role or warehouse takes
// effect immediately (doc 02 §4, INV-018).
export async function buildCtx(
  userId: string,
  opts: { requestId: string; channel: NonNullable<Ctx["channel"]> },
): Promise<Ctx> {
  const user = await db.user.findUnique({
    where: { id: userId },
    include: {
      roles: { include: { role: { include: { permissions: true } } } },
      warehouses: { select: { warehouseId: true } },
    },
  });
  if (!user || user.status !== "active") throw new AppError("forbidden", "User is not active", { reason: "inactive" });

  const roles = user.roles.map((r) => r.role);
  // Doc 02 §6: 2FA-required roles get no permissions until 2FA is on (web sessions only).
  if (opts.channel === "web" && roles.some((r) => r.requires2fa) && !user.twoFactorEnabled) {
    throw new AppError("forbidden", "Two-factor authentication is required for your role", { reason: "2fa_required" });
  }

  const permissions = new Set<string>();
  const limits = new Map<string, Prisma.Decimal | null>();
  for (const grant of roles.flatMap((r) => r.permissions)) {
    permissions.add(grant.permissionCode);
    const prev = limits.get(grant.permissionCode);
    // Highest limit wins; any unlimited grant wins outright (doc 02 §5.1).
    if (prev === null) continue;
    limits.set(grant.permissionCode, grant.limitAmount === null || prev === undefined || grant.limitAmount.gt(prev) ? grant.limitAmount : prev);
  }

  return {
    companyId: user.companyId,
    userId: user.id,
    warehouseIds: roles.some((r) => r.allWarehouses) ? "all" : user.warehouses.map((w) => w.warehouseId),
    permissions,
    limits,
    requestId: opts.requestId,
    channel: opts.channel,
    salesChannel: user.salesChannel ?? undefined,
  };
}

// API key (`x-api-key`, sales channels → service user) or the session cookie.
export async function requestCtx(req: Request, requestId: string): Promise<Ctx> {
  const key = req.headers.get("x-api-key");
  if (key) {
    const res = await auth.api.verifyApiKey({ body: { key } });
    if (!res.valid || !res.key) throw new AppError("forbidden", "Invalid API key", { reason: "unauthenticated" });
    const owner = await db.user.findUnique({ where: { id: res.key.referenceId }, select: { isService: true } });
    if (!owner?.isService) throw new AppError("forbidden", "API key is not bound to a service user", { reason: "unauthenticated" });
    return buildCtx(res.key.referenceId, { requestId, channel: "api" });
  }
  return sessionCtx(req.headers, requestId);
}

export async function sessionCtx(headers: Headers, requestId: string): Promise<Ctx> {
  const session = await auth.api.getSession({ headers });
  if (!session) throw new AppError("forbidden", "Not signed in", { reason: "unauthenticated" });
  // A new sign-in creates a new session, so createdAt = last (re-)authentication (doc 26 step-up).
  return { ...(await buildCtx(session.user.id, { requestId, channel: "web" })), authAt: new Date(session.session.createdAt) };
}
