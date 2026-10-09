import { listInbox } from "@/server/approvals/inbox";
import { requirePermission, type Ctx } from "@/server/core/ctx";
import { db } from "@/server/db";
import { dec } from "@/server/inventory/post";
import { utcToday } from "@/server/inventory/reservations";
import { liveValue } from "@/server/inventory/valuation";
import { visibleTo } from "@/server/notifications/center";
import { lowStockRows, positions } from "./reports";

// Doc 16 §1 dashboard. Read-only, every widget limited to the caller's warehouses.
export async function getDashboard(ctx: Ctx) {
  await requirePermission(ctx, ["inventory.view", "reports.view"]);
  const scope = ctx.warehouseIds === "all" ? null : ctx.warehouseIds;
  const wh = scope ? { in: scope } : undefined;
  const today = utcToday();
  const in30 = new Date(today.getTime() + 30 * 86_400_000);
  const since30 = new Date(today.getTime() - 29 * 86_400_000);
  const trScope = scope ? { OR: [{ fromWarehouseId: { in: scope } }, { toWarehouseId: { in: scope } }] } : {};

  const [value, pos, low, skusActive, expiring, pendingPos, pendingTransfers, openAdjustments, volume, recentMoves, recentAudit, variancesOpen, drift] = await Promise.all([
    liveValue(ctx),
    positions(ctx, { scope, variantIds: null }),
    lowStockRows(ctx, {}),
    db.productVariant.count({ where: { companyId: ctx.companyId, status: "active" } }),
    db.stockBalance.aggregate({ where: { companyId: ctx.companyId, warehouseId: wh, onHand: { gt: 0 }, batch: { expiryDate: { lte: in30 } } }, _sum: { onHand: true }, _count: { _all: true } }),
    db.purchaseOrder.count({ where: { companyId: ctx.companyId, warehouseId: wh, status: { in: ["submitted", "approved", "ordered", "partially_received"] } } }),
    db.transfer.count({ where: { companyId: ctx.companyId, ...trScope, status: { in: ["submitted", "approved", "in_transit", "partially_received"] } } }),
    db.stockAdjustment.count({ where: { companyId: ctx.companyId, warehouseId: wh, status: { in: ["draft", "submitted", "approved"] } } }),
    db.$queryRaw<{ d: string; n: number }[]>`
      SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') d, COUNT(*)::int n FROM inventory_movement
      WHERE company_id = ${ctx.companyId} AND created_at >= ${since30} AND type::text NOT IN ('reservation', 'reservation_release')
        AND (${scope}::text[] IS NULL OR warehouse_id = ANY(${scope}::text[]))
      GROUP BY 1 ORDER BY 1`,
    db.inventoryMovement.findMany({
      where: { companyId: ctx.companyId, warehouseId: wh }, orderBy: { id: "desc" }, take: 20,
      select: { id: true, createdAt: true, type: true, dOnHand: true, variantId: true, variant: { select: { sku: true } }, warehouse: { select: { code: true } } },
    }),
    ctx.permissions.has("audit.view")
      ? db.auditLog.findMany({
        where: { companyId: ctx.companyId, ...(scope ? { OR: [{ warehouseId: null }, { warehouseId: { in: scope } }] } : {}), action: { notIn: ["auth.login"] } },
        orderBy: { id: "desc" }, take: 20, select: { id: true, at: true, action: true, entityType: true, entityId: true },
      })
      : Promise.resolve([]),
    db.transferLine.count({ where: { qtyMissingReported: { gt: 0 }, transfer: { companyId: ctx.companyId, ...trScope } } }),
    db.notification.count({ where: { AND: [visibleTo(ctx), { type: "reconcile.drift", createdAt: { gte: new Date(Date.now() - 7 * 86_400_000) } }] } }),
  ]);

  const L = new Map((await db.productVariant.findMany({
    where: { id: { in: [...new Set(value.lines.map((l) => l.variantId))] } }, select: { id: true, product: { select: { category: { select: { name: true } } } } },
  })).map((v) => [v.id, v.product.category?.name ?? "(none)"]));
  const W = new Map((await db.warehouse.findMany({ where: { companyId: ctx.companyId, id: wh }, select: { id: true, code: true } })).map((w) => [w.id, w.code]));
  const sumBy = (k: (l: (typeof value.lines)[number]) => string) => {
    const m = new Map<string, ReturnType<typeof dec>>();
    for (const l of value.lines) m.set(k(l), (m.get(k(l)) ?? dec(0)).plus(l.value));
    return [...m.entries()].map(([label, v]) => ({ label, value: v.toFixed(2) })).filter((x) => x.value !== "0.00").sort((a, b) => Number(b.value) - Number(a.value)); // sort for display only
  };
  let units = dec(0), damagedValue = dec(0);
  for (const x of pos.values()) {
    units = units.plus(x.onHand);
    if (!x.costQty.isZero()) damagedValue = damagedValue.plus(x.damaged.times(x.value).div(x.costQty));
  }
  const days = Array.from({ length: 30 }, (_, i) => new Date(since30.getTime() + i * 86_400_000).toISOString().slice(0, 10));
  const inbox = await listInbox(ctx).catch(() => ({ items: [], slaHours: 0 }));
  const expired = await db.stockBalance.aggregate({ where: { companyId: ctx.companyId, warehouseId: wh, OR: [{ expired: { gt: 0 } }, { onHand: { gt: 0 }, batch: { expiryDate: { lte: new Date(today.getTime() + 7 * 86_400_000) } } }] }, _count: { _all: true } });

  return {
    kpis: {
      inventoryValue: dec(value.total).toFixed(2), inTransitValue: dec(value.inTransit).toFixed(2), skusActive, totalUnits: units.toString(),
      lowStock: low.filter((r) => r.status === "low").length, outOfStock: low.filter((r) => r.status === "out").length,
      expiring30: { positions: expiring._count._all, units: dec(expiring._sum.onHand).toString() }, damagedValue: damagedValue.toFixed(2),
      pendingPos, pendingTransfers, openAdjustments,
    },
    charts: {
      valueByWarehouse: sumBy((l) => W.get(l.warehouseId) ?? l.warehouseId),
      valueByCategory: sumBy((l) => L.get(l.variantId) ?? "(none)"),
      movements30d: days.map((d) => ({ day: d, count: volume.find((v) => v.d === d)?.n ?? 0 })),
    },
    lowStock: low.slice(0, 10),
    recent: [
      ...recentMoves.map((m) => ({ at: m.createdAt, kind: "movement" as const, text: `${m.type} ${m.variant.sku} @ ${m.warehouse.code} (${dec(m.dOnHand).toString()})`, link: `/reports/ledger?variantId=${m.variantId}` })),
      ...recentAudit.map((a) => ({ at: a.at, kind: "audit" as const, text: `${a.action} ${a.entityType}`, link: `/admin/audit/${a.id}` })),
    ].sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, 20),
    approvals: inbox.items.slice(0, 5),
    alerts: [
      ...(expired._count._all ? [{ kind: "expiry", text: `${expired._count._all} batch position(s) expired or expiring within 7 days`, link: "/reports/summary" }] : []),
      ...(low.some((r) => r.status === "out") ? [{ kind: "stockout", text: `${low.filter((r) => r.status === "out").length} item(s) out of stock`, link: "/reports/low-stock" }] : []),
      ...(variancesOpen ? [{ kind: "discrepancy", text: `${variancesOpen} transfer line(s) with missing units awaiting approval`, link: "/reports/transfers" }] : []),
      ...(drift ? [{ kind: "discrepancy", text: "Ledger reconciler reported drift this week", link: "/admin/audit?action=reconcile.drift" }] : []),
    ],
  };
}
