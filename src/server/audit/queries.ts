import { requirePermission, type Ctx } from "@/server/core/ctx";
import { AppError } from "@/server/core/errors";
import { db } from "@/server/db";

// Audit explorer (doc 18, A-04): `audit.view`; warehouse-scoped users only see
// entries tied to their warehouses.
const scoped = (ctx: Ctx) => (ctx.warehouseIds === "all" ? {} : { warehouseId: { in: ctx.warehouseIds } });

export async function listAudit(
  ctx: Ctx,
  input: { page: number; perPage: number; entityType?: string; entityId?: string; action?: string; actorId?: string; from?: Date; to?: Date },
) {
  await requirePermission(ctx, "audit.view");
  const where = {
    companyId: ctx.companyId,
    ...scoped(ctx),
    entityType: input.entityType,
    entityId: input.entityId,
    action: input.action,
    actorId: input.actorId,
    at: input.from || input.to ? { gte: input.from, lte: input.to } : undefined,
  };
  const [total, items] = await Promise.all([
    db.auditLog.count({ where }),
    db.auditLog.findMany({
      where, orderBy: { id: "desc" }, skip: (input.page - 1) * input.perPage, take: input.perPage,
      select: { id: true, at: true, actorId: true, action: true, entityType: true, entityId: true, warehouseId: true, reason: true, channel: true },
    }),
  ]);
  return { total, page: input.page, perPage: input.perPage, items: await withActors(ctx, items) };
}

export async function getAudit(ctx: Ctx, id: string) {
  await requirePermission(ctx, "audit.view");
  const entry = await db.auditLog.findFirst({ where: { id, companyId: ctx.companyId, ...scoped(ctx) } });
  if (!entry) throw new AppError("not_found", "Audit entry not found");
  return (await withActors(ctx, [entry]))[0];
}

async function withActors<T extends { actorId: string }>(ctx: Ctx, rows: T[]) {
  const users = await db.user.findMany({
    where: { companyId: ctx.companyId, id: { in: [...new Set(rows.map((r) => r.actorId))] } },
    select: { id: true, name: true, email: true },
  });
  const byId = new Map(users.map((u) => [u.id, u]));
  return rows.map((r) => ({ ...r, actor: byId.get(r.actorId) ?? null }));
}

// Before/after → changed leaf paths, for the explorer's diff view.
export function diff(before: unknown, after: unknown, path = ""): { path: string; before: unknown; after: unknown }[] {
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  if (isObj(before) && isObj(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
      .flatMap((k) => diff(before[k], after[k], path ? `${path}.${k}` : k));
  }
  return JSON.stringify(before) === JSON.stringify(after) ? [] : [{ path: path || "(value)", before, after }];
}
