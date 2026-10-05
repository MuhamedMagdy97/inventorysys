import type { Prisma, ReservationStatus } from "@/generated/prisma/client";
import { requirePermission, scopeFilter, type Ctx } from "@/server/core/ctx";
import { AppError } from "@/server/core/errors";
import { db } from "@/server/db";

// Read side of doc 12 (sales orders = external refs + their reservations). Writes live in
// src/server/inventory/reservations.ts. Only reservations in the caller's warehouses show.

const include = {
  order: true,
  variant: { select: { sku: true, name: true } },
  warehouse: { select: { code: true } },
  lines: { include: { batch: { select: { batchNo: true, expiryDate: true } } } },
} satisfies Prisma.ReservationInclude;

export async function listReservations(
  ctx: Ctx,
  f: { q?: string; status?: ReservationStatus; orderId?: string; reservationId?: string; warehouseId?: string; page?: number; perPage?: number },
) {
  await requirePermission(ctx, "sales.view", { warehouseId: f.warehouseId });
  const where: Prisma.ReservationWhereInput = {
    companyId: ctx.companyId,
    warehouseId: scopeFilter(ctx, f.warehouseId),
    status: f.status,
    id: f.reservationId,
    salesOrderRefId: f.orderId,
    ...(f.q && {
      OR: [
        { order: { externalOrderId: { contains: f.q, mode: "insensitive" } } },
        { variant: { sku: { contains: f.q, mode: "insensitive" } } },
      ],
    }),
  };
  const perPage = f.perPage ?? 50;
  const [items, total] = await Promise.all([
    db.reservation.findMany({ where, include, orderBy: { createdAt: "desc" }, skip: ((f.page ?? 1) - 1) * perPage, take: perPage }),
    db.reservation.count({ where }),
  ]);
  return { items, total };
}

// SO-07: order status is derived — open while any reservation is open; then fulfilled if
// anything shipped, else cancelled.
export function orderStatus(rs: { status: ReservationStatus; qtyFulfilled: Prisma.Decimal }[]) {
  if (rs.some((r) => r.status === "active" || r.status === "partially_fulfilled")) return "open";
  return rs.some((r) => r.qtyFulfilled.gt(0)) ? "fulfilled" : "cancelled";
}

export async function getSalesOrder(ctx: Ctx, id: string) {
  const order = await db.salesOrderRef.findFirst({ where: { id, companyId: ctx.companyId } });
  if (!order) throw new AppError("not_found", "Order not found");
  const { items } = await listReservations(ctx, { orderId: order.id, perPage: 500 });
  if (items.length === 0) throw new AppError("not_found", "Order not found"); // none in the caller's scope
  return { ...order, status: orderStatus(items), reservations: items.map((r) => ({ ...r, order: undefined })) };
}
