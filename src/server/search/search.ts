import type { Ctx } from "@/server/core/ctx";
import { AppError } from "@/server/core/errors";
import { db } from "@/server/db";

// Doc 25 global search: SKU / barcode (+ aliases) / PO / sales order / batch / serial /
// supplier / warehouse / user. Each group appears only with its view grant, and
// warehouse-bound results only for warehouses in the caller's scope (N-02 style, no leaks).
export type Hit = { group: string; label: string; detail: string; link: string };

const PER_GROUP = 8;

export async function search(ctx: Ctx, input: { q: string }): Promise<{ q: string; hits: Hit[] }> {
  const q = input.q.trim();
  if (q.length < 2 || q.length > 100) throw new AppError("validation_error", "Search needs 2–100 characters", { field: "q" });
  const has = (p: string) => ctx.permissions.has(p);
  const like = { contains: q, mode: "insensitive" as const };
  const scope = ctx.warehouseIds === "all" ? undefined : { in: ctx.warehouseIds };
  const companyId = ctx.companyId;
  const groups: Promise<Hit[]>[] = [];

  if (has("products.view")) {
    groups.push((async () => {
      const aliasIds = [
        ...(await db.skuAlias.findMany({ where: { companyId, oldSku: { equals: q, mode: "insensitive" } }, select: { variantId: true } })),
        ...(await db.barcodeAlias.findMany({ where: { companyId, barcode: q, expiresAt: { gt: new Date() } }, select: { variantId: true } })),
      ].map((a) => a.variantId);
      const vs = await db.productVariant.findMany({
        where: { companyId, OR: [{ sku: like }, { barcode: q }, { name: like }, { product: { name: like } }, { id: { in: aliasIds } }] },
        take: PER_GROUP, orderBy: { sku: "asc" }, select: { sku: true, name: true, status: true, productId: true, product: { select: { name: true } } },
      });
      return vs.map((v) => ({ group: "Products", label: v.sku, detail: `${v.product.name}${v.name ? ` ${v.name}` : ""} · ${v.status}`, link: `/products/${v.productId}` }));
    })());
  }
  if (has("purchases.view")) {
    groups.push(db.purchaseOrder.findMany({ where: { companyId, warehouseId: scope, OR: [{ number: like }, { supplierName: like }] }, take: PER_GROUP, orderBy: { id: "desc" }, select: { id: true, number: true, supplierName: true, status: true } })
      .then((r) => r.map((p) => ({ group: "Purchase orders", label: p.number, detail: `${p.supplierName} · ${p.status}`, link: `/purchase-orders/${p.id}` }))));
  }
  if (has("sales.view")) {
    // A sales order is visible when one of its reservations is in scope (or it has none yet).
    groups.push(db.salesOrderRef.findMany({
      where: { companyId, externalOrderId: like, ...(scope ? { OR: [{ reservations: { some: { warehouseId: scope } } }, { reservations: { none: {} } }] } : {}) },
      take: PER_GROUP, orderBy: { id: "desc" }, select: { id: true, externalOrderId: true, channel: true },
    }).then((r) => r.map((o) => ({ group: "Sales orders", label: o.externalOrderId, detail: o.channel, link: `/sales-orders?order=${o.id}` }))));
  }
  if (has("inventory.view")) {
    groups.push(db.batch.findMany({
      where: { companyId, batchNo: like, ...(scope ? { stockBalances: { some: { warehouseId: scope } } } : {}) },
      take: PER_GROUP, orderBy: { batchNo: "asc" }, select: { batchNo: true, expiryDate: true, variantId: true, variant: { select: { sku: true } } },
    }).then((r) => r.map((b) => ({ group: "Batches", label: b.batchNo, detail: `${b.variant.sku}${b.expiryDate ? ` · expires ${b.expiryDate.toISOString().slice(0, 10)}` : ""}`, link: `/reports/ledger?variantId=${b.variantId}` }))));
    groups.push(db.serialUnit.findMany({
      where: { companyId, serialNo: like, warehouseId: scope }, take: PER_GROUP, orderBy: { serialNo: "asc" },
      select: { serialNo: true, status: true, variantId: true, variant: { select: { sku: true } }, warehouse: { select: { code: true } } },
    }).then((r) => r.map((u) => ({ group: "Serials", label: u.serialNo, detail: `${u.variant.sku} · ${u.status} @ ${u.warehouse.code}`, link: `/reports/ledger?variantId=${u.variantId}` }))));
  }
  if (has("suppliers.view")) {
    groups.push(db.supplier.findMany({ where: { companyId, OR: [{ name: like }, { code: like }] }, take: PER_GROUP, orderBy: { name: "asc" }, select: { id: true, code: true, name: true, status: true } })
      .then((r) => r.map((s) => ({ group: "Suppliers", label: s.name, detail: `${s.code} · ${s.status}`, link: `/suppliers/${s.id}` }))));
  }
  if (has("warehouses.view")) {
    groups.push(db.warehouse.findMany({ where: { companyId, id: scope, OR: [{ name: like }, { code: like }] }, take: PER_GROUP, orderBy: { code: "asc" }, select: { id: true, code: true, name: true } })
      .then((r) => r.map((w) => ({ group: "Warehouses", label: w.code, detail: w.name, link: `/warehouses/${w.id}` }))));
  }
  if (has("users.view")) {
    groups.push(db.user.findMany({ where: { companyId, isSystem: false, OR: [{ name: like }, { email: like }] }, take: PER_GROUP, orderBy: { name: "asc" }, select: { id: true, name: true, email: true } })
      .then((r) => r.map((u) => ({ group: "Users", label: u.name, detail: u.email, link: `/admin/users/${u.id}` }))));
  }
  return { q, hits: (await Promise.all(groups)).flat() };
}
