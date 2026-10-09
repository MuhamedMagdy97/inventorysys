import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { writeAudit } from "@/server/core/audit";
import type { Ctx } from "@/server/core/ctx";
import { AppError } from "@/server/core/errors";
import { db, type Tx } from "@/server/db";
import { CATEGORIES, type Category } from "./notify";

// Doc 25 notification center. Every signed-in user sees only their own rows plus the
// broadcasts they may see: warehouse in scope (N-02, no cross-warehouse leaks) and the
// row's grant held. Read state is per user (notification_read).

export function visibleTo(ctx: Pick<Ctx, "companyId" | "userId" | "warehouseIds" | "permissions">): Prisma.NotificationWhereInput {
  return {
    companyId: ctx.companyId,
    OR: [
      { userId: ctx.userId },
      {
        userId: null,
        AND: [
          ctx.warehouseIds === "all" ? {} : { OR: [{ warehouseId: null }, { warehouseId: { in: ctx.warehouseIds } }] },
          { OR: [{ permission: null }, { permission: { in: [...ctx.permissions] } }] },
        ],
      },
    ],
  };
}

export async function listNotifications(ctx: Ctx, input: { unreadOnly?: boolean; page: number; perPage: number }) {
  const unread = { reads: { none: { userId: ctx.userId } } };
  const where = { AND: [visibleTo(ctx), ...(input.unreadOnly ? [unread] : [])] };
  const [total, unreadCount, items] = await Promise.all([
    db.notification.count({ where }),
    db.notification.count({ where: { AND: [visibleTo(ctx), unread] } }),
    db.notification.findMany({
      where, orderBy: { id: "desc" }, skip: (input.page - 1) * input.perPage, take: input.perPage,
      include: { reads: { where: { userId: ctx.userId }, select: { readAt: true } } },
    }),
  ]);
  return {
    total, unread: unreadCount, page: input.page, perPage: input.perPage,
    items: items.map(({ reads, ...n }) => ({ ...n, readAt: reads[0]?.readAt ?? null })),
  };
}

// ids omitted = mark everything visible as read.
export async function markRead(tx: Tx, ctx: Ctx, input: { ids?: string[] }) {
  const rows = await tx.notification.findMany({
    where: { AND: [visibleTo(ctx), { reads: { none: { userId: ctx.userId } } }, input.ids ? { id: { in: input.ids } } : {}] },
    select: { id: true, userId: true },
  });
  if (input.ids && rows.length < input.ids.length) {
    const visible = await tx.notification.count({ where: { AND: [visibleTo(ctx), { id: { in: input.ids } }] } });
    if (visible < input.ids.length) throw new AppError("not_found", "Notification not found");
  }
  await tx.notificationRead.createMany({ data: rows.map((r) => ({ notificationId: r.id, userId: ctx.userId })), skipDuplicates: true });
  const own = rows.filter((r) => r.userId === ctx.userId).map((r) => r.id);
  if (own.length) await tx.notification.updateMany({ where: { id: { in: own } }, data: { readAt: new Date() } });
  return { marked: rows.length };
}

export const zCategories = z.array(z.enum(Object.keys(CATEGORIES) as [Category, ...Category[]])).max(10);

// N-02: in-app is always on; email is opt-in per category. Users manage their own.
export async function getPreferences(ctx: Ctx) {
  const u = await db.user.findUniqueOrThrow({ where: { id: ctx.userId }, select: { emailCategories: true } });
  return { emailCategories: u.emailCategories as Category[] };
}

export async function setPreferences(tx: Tx, ctx: Ctx, input: { emailCategories: string[] }) {
  const emailCategories = [...new Set(zCategories.parse(input.emailCategories))];
  const before = await tx.user.findUniqueOrThrow({ where: { id: ctx.userId }, select: { emailCategories: true, companyId: true } });
  if (before.companyId !== ctx.companyId) throw new AppError("not_found", "User not found");
  await tx.user.update({ where: { id: ctx.userId }, data: { emailCategories } });
  await writeAudit(tx, ctx, {
    action: "update", entityType: "notification_preferences", entityId: ctx.userId,
    before: { emailCategories: before.emailCategories }, after: { emailCategories },
  });
  return { emailCategories };
}
