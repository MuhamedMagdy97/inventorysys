import { z } from "zod";
import { MovementType } from "@/generated/prisma/client";
import { writeAudit } from "@/server/core/audit";
import { requirePermission, type Ctx } from "@/server/core/ctx";
import { db } from "@/server/db";
import { toCsv } from "@/server/imports/files";
import { dec, type Dec } from "@/server/inventory/post";
import { liveValue, valueAt } from "@/server/inventory/valuation";

// Doc 16 §2, V1 report set. Reports only READ the ledger and its caches (stock_balance,
// stock_allocation, variant_cost, documents). Every report: `reports.view`, the company,
// and the caller's warehouse scope (a requested warehouse out of scope → forbidden).
// Export = the same report as CSV, `reports.export`, one `export` audit row (doc 18).

const dateTo = z.string().transform((s, c) => {
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T23:59:59.999Z` : s); // a date-only "to" includes that day
  if (Number.isNaN(d.getTime())) c.addIssue({ code: "custom", message: "Invalid date" });
  return d;
});

export const ReportFilters = z.object({
  warehouseId: z.uuid().optional(),
  categoryId: z.uuid().optional(),
  brandId: z.uuid().optional(),
  variantId: z.uuid().optional(),
  from: z.coerce.date().optional(),
  to: dateTo.optional(),
  asOf: dateTo.optional(), // valuation: point in time (INV-022)
  type: z.enum(MovementType).optional(), // ledger
  sourceType: z.string().max(64).optional(), // ledger
  actorId: z.uuid().optional(), // ledger
  groupBy: z.enum(["variant", "warehouse", "category"]).optional(), // valuation
  limit: z.coerce.number().int().min(1).max(10_000).optional(), // ledger rows
});
export type ReportFilters = z.infer<typeof ReportFilters>;

type Cell = string | number | null;
export type Section = { title?: string; columns: [key: string, label: string][]; rows: Record<string, Cell>[]; total?: Record<string, Cell> };
export type Report = { name: ReportName; title: string; sections: Section[]; notes: string[] };

export const REPORTS = {
  summary: { title: "Inventory summary", about: "On hand / reserved / available / blocked / damaged / expired + WAC value per SKU and warehouse.", filters: ["warehouse", "product"] },
  ledger: { title: "Stock ledger", about: "Every movement with actor, source, reason and cost.", filters: ["warehouse", "product", "dates", "ledger"] },
  valuation: { title: "Valuation", about: "Quantity × WAC by SKU, warehouse or category, with the in-transit line; optional point in time.", filters: ["warehouse", "product", "valuation"] },
  "low-stock": { title: "Low / out of stock", about: "Available at or below the reorder point; out = available ≤ 0.", filters: ["warehouse", "product"] },
  damaged: { title: "Damaged stock", about: "Damaged quantity and value, with damage reasons in the period.", filters: ["warehouse", "product", "dates"] },
  purchasing: { title: "Purchasing & supplier performance", about: "POs by status; per supplier lead time, on-time rate, fill and return rate.", filters: ["warehouse", "product", "dates"] },
  returns: { title: "Returns", about: "Purchase and customer returns by status and reason, inspection dispositions, return rates.", filters: ["warehouse", "product", "dates"] },
  transfers: { title: "Transfers & in transit", about: "Open transfers with days in transit and value in transit; damaged / missing variances.", filters: ["warehouse", "product", "dates"] },
  movement: { title: "Product movement", about: "Physical units in / out / net per SKU and warehouse.", filters: ["warehouse", "product", "dates"] },
} as const;
export type ReportName = keyof typeof REPORTS;
export const isReport = (s: string): s is ReportName => Object.hasOwn(REPORTS, s);

const s = (d: Dec) => d.toString();
const day = (d: Date | null | undefined) => d?.toISOString().slice(0, 10) ?? null;

type Prep = { scope: string[] | null; variantIds: string[] | null };

async function prep(ctx: Ctx, f: ReportFilters): Promise<Prep> {
  await requirePermission(ctx, "reports.view", { warehouseId: f.warehouseId });
  const scope = f.warehouseId ? [f.warehouseId] : ctx.warehouseIds === "all" ? null : ctx.warehouseIds;
  if (!f.categoryId && !f.brandId && !f.variantId) return { scope, variantIds: null };
  let categoryIds: string[] | undefined;
  if (f.categoryId) {
    const cat = await db.category.findFirst({ where: { id: f.categoryId, companyId: ctx.companyId }, select: { path: true } });
    // Doc 16: a category includes its sub-categories.
    categoryIds = cat ? (await db.category.findMany({ where: { companyId: ctx.companyId, path: { startsWith: cat.path } }, select: { id: true } })).map((c) => c.id) : [];
  }
  const vs = await db.productVariant.findMany({
    where: {
      companyId: ctx.companyId, id: f.variantId,
      product: { ...(categoryIds ? { categoryId: { in: categoryIds } } : {}), ...(f.brandId ? { brandId: f.brandId } : {}) },
    },
    select: { id: true },
  });
  return { scope, variantIds: vs.map((v) => v.id) };
}

const whereWh = (p: Prep) => (p.scope ? { in: p.scope } : undefined);
const whereVar = (p: Prep) => (p.variantIds ? { in: p.variantIds } : undefined);

async function labels(ctx: Ctx, variantIds: Iterable<string>, warehouseIds: Iterable<string>) {
  const [vs, ws] = await Promise.all([
    db.productVariant.findMany({
      where: { companyId: ctx.companyId, id: { in: [...new Set(variantIds)] } },
      select: { id: true, sku: true, name: true, product: { select: { name: true, category: { select: { path: true } } } } },
    }),
    db.warehouse.findMany({ where: { companyId: ctx.companyId, id: { in: [...new Set(warehouseIds)] } }, select: { id: true, code: true } }),
  ]);
  const v = new Map(vs.map((x) => [x.id, { sku: x.sku, name: x.name ? `${x.product.name} ${x.name}` : x.product.name, category: x.product.category?.path ?? "(none)" }]));
  const w = new Map(ws.map((x) => [x.id, x.code]));
  return { v: (id: string) => v.get(id) ?? { sku: id, name: "", category: "(none)" }, w: (id: string) => w.get(id) ?? id };
}

const key = (r: { variantId: string; warehouseId: string }) => `${r.variantId}|${r.warehouseId}`;
const split = (k: string) => k.split("|") as [string, string];
const wacOf = (qty: Dec, value: Dec) => (qty.isZero() ? dec(0) : value.div(qty).toDecimalPlaces(4));

// Per (variant, warehouse): physical buckets, reserved, WAC value — shared by summary,
// low-stock, damaged and the dashboard.
export async function positions(ctx: Ctx, p: Prep) {
  const where = { companyId: ctx.companyId, warehouseId: whereWh(p), variantId: whereVar(p) };
  const [balances, allocations, costs, settings] = await Promise.all([
    db.stockBalance.groupBy({ by: ["variantId", "warehouseId"], where, _sum: { onHand: true, blocked: true, damaged: true, expired: true } }),
    db.stockAllocation.groupBy({ by: ["variantId", "warehouseId"], where, _sum: { qtyReserved: true } }),
    db.variantCost.findMany({ where }),
    db.variantWarehouseSettings.findMany({ where }),
  ]);
  type Pos = { onHand: Dec; blocked: Dec; damaged: Dec; expired: Dec; reserved: Dec; costQty: Dec; value: Dec; reorderPoint: Dec | null; reorderQty: Dec | null };
  const map = new Map<string, Pos>();
  const at = (r: { variantId: string; warehouseId: string }) => {
    const k = key(r);
    if (!map.has(k)) map.set(k, { onHand: dec(0), blocked: dec(0), damaged: dec(0), expired: dec(0), reserved: dec(0), costQty: dec(0), value: dec(0), reorderPoint: null, reorderQty: null });
    return map.get(k)!;
  };
  for (const b of balances) Object.assign(at(b), { onHand: dec(b._sum.onHand), blocked: dec(b._sum.blocked), damaged: dec(b._sum.damaged), expired: dec(b._sum.expired) });
  for (const a of allocations) at(a).reserved = dec(a._sum.qtyReserved);
  for (const c of costs) Object.assign(at(c), { costQty: dec(c.qty), value: dec(c.value) });
  for (const x of settings) Object.assign(at(x), { reorderPoint: x.reorderPoint && dec(x.reorderPoint), reorderQty: x.reorderQty && dec(x.reorderQty) });
  return map;
}

async function summary(ctx: Ctx, f: ReportFilters): Promise<Section[]> {
  const pos = await positions(ctx, await prep(ctx, f));
  const keys = [...pos.keys()].filter((k) => { const x = pos.get(k)!; return ![x.onHand, x.blocked, x.damaged, x.expired, x.reserved, x.value].every((d) => d.isZero()); });
  const L = await labels(ctx, keys.map((k) => split(k)[0]), keys.map((k) => split(k)[1]));
  const cols = ["on_hand", "reserved", "available", "blocked", "damaged", "expired", "value"] as const;
  const tot = Object.fromEntries(cols.map((c) => [c, dec(0)])) as Record<(typeof cols)[number], Dec>;
  const rows = keys.map((k) => {
    const [v, w] = split(k), x = pos.get(k)!;
    const vals = { on_hand: x.onHand, reserved: x.reserved, available: x.onHand.minus(x.reserved), blocked: x.blocked, damaged: x.damaged, expired: x.expired, value: x.value };
    for (const c of cols) tot[c] = tot[c].plus(vals[c]);
    return { sku: L.v(v).sku, name: L.v(v).name, warehouse: L.w(w), ...Object.fromEntries(cols.map((c) => [c, s(vals[c])])), wac: s(wacOf(x.costQty, x.value)) };
  }).sort((a, b) => `${a.sku}${a.warehouse}`.localeCompare(`${b.sku}${b.warehouse}`));
  return [{
    columns: [["sku", "SKU"], ["name", "Name"], ["warehouse", "Warehouse"], ["on_hand", "On hand"], ["reserved", "Reserved"], ["available", "Available"], ["blocked", "Blocked"], ["damaged", "Damaged"], ["expired", "Expired"], ["wac", "WAC"], ["value", "Value"]],
    rows, total: { sku: "Total", ...Object.fromEntries(cols.map((c) => [c, s(tot[c])])) },
  }];
}

async function ledger(ctx: Ctx, f: ReportFilters): Promise<{ sections: Section[]; notes: string[] }> {
  const p = await prep(ctx, f);
  const where = {
    companyId: ctx.companyId, warehouseId: whereWh(p), variantId: whereVar(p), type: f.type, sourceType: f.sourceType, actorId: f.actorId,
    createdAt: f.from || f.to ? { gte: f.from, lte: f.to } : undefined,
  };
  const limit = f.limit ?? 1000;
  const [total, ms] = await Promise.all([
    db.inventoryMovement.count({ where }),
    db.inventoryMovement.findMany({
      where, orderBy: { id: "desc" }, take: limit,
      include: { variant: { select: { sku: true } }, warehouse: { select: { code: true } }, bin: { select: { code: true } }, batch: { select: { batchNo: true } } },
    }),
  ]);
  const actors = new Map((await db.user.findMany({ where: { id: { in: [...new Set(ms.map((m) => m.actorId))] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  const rows = ms.map((m) => ({
    at: m.createdAt.toISOString().replace("T", " ").slice(0, 19), type: m.type, sku: m.variant.sku, warehouse: m.warehouse.code, bin: m.bin?.code ?? null, batch: m.batch?.batchNo ?? null,
    d_on_hand: s(dec(m.dOnHand)), d_blocked: s(dec(m.dBlocked)), d_damaged: s(dec(m.dDamaged)), d_expired: s(dec(m.dExpired)), d_reserved: s(dec(m.dReserved)),
    unit_cost: m.unitCost?.toString() ?? null, value_delta: s(dec(m.valueDelta)), source: `${m.sourceType}:${m.sourceId}`, reason: m.reasonCode, actor: actors.get(m.actorId) ?? m.actorId,
  }));
  return {
    sections: [{
      columns: [["at", "When (UTC)"], ["type", "Type"], ["sku", "SKU"], ["warehouse", "Warehouse"], ["bin", "Bin"], ["batch", "Batch"], ["d_on_hand", "Δ on hand"], ["d_blocked", "Δ blocked"], ["d_damaged", "Δ damaged"], ["d_expired", "Δ expired"], ["d_reserved", "Δ reserved"], ["unit_cost", "Unit cost"], ["value_delta", "Δ value"], ["source", "Source"], ["reason", "Reason"], ["actor", "Actor"]],
      rows,
    }],
    notes: total > limit ? [`Showing the newest ${limit} of ${total} movements — narrow the filters or raise the limit (max 10 000).`] : [],
  };
}

async function valuation(ctx: Ctx, f: ReportFilters): Promise<{ sections: Section[]; notes: string[] }> {
  const p = await prep(ctx, f);
  const v = f.asOf ? await valueAt(ctx, f.asOf, { warehouseId: f.warehouseId }) : await liveValue(ctx, { warehouseId: f.warehouseId });
  const lines = p.variantIds ? v.lines.filter((l) => p.variantIds!.includes(l.variantId)) : v.lines;
  const L = await labels(ctx, lines.map((l) => l.variantId), lines.map((l) => l.warehouseId));
  const by = f.groupBy ?? "variant";
  const groups = new Map<string, { qty: Dec; value: Dec }>();
  for (const l of lines) {
    const k = by === "warehouse" ? L.w(l.warehouseId) : by === "category" ? L.v(l.variantId).category : `${L.v(l.variantId).sku}\u0000${L.w(l.warehouseId)}`;
    const g = groups.get(k) ?? { qty: dec(0), value: dec(0) };
    groups.set(k, { qty: g.qty.plus(l.qty), value: g.value.plus(l.value) });
  }
  const rows: Record<string, Cell>[] = [...groups.entries()].filter(([, g]) => !g.qty.isZero() || !g.value.isZero()).sort(([a], [b]) => a.localeCompare(b)).map(([k, g]) => {
    const [label, wh] = k.split("\u0000");
    return { label, warehouse: wh ?? null, qty: s(g.qty), wac: s(wacOf(g.qty, g.value)), value: s(g.value) };
  });
  let total = lines.reduce((t, l) => t.plus(l.value), dec(0));
  const notes = [f.asOf ? `Point-in-time value at ${f.asOf.toISOString()} (replay of movement snapshots, INV-022).` : "Live value from the cost layer (WAC × all physical buckets)."];
  if (p.variantIds) notes.push("In-transit value is shown only without a product / category / brand filter.");
  else {
    rows.push({ label: "In transit (doc 16: neither vanishes nor double-counts)", warehouse: null, qty: null, wac: null, value: v.inTransit });
    total = total.plus(v.inTransit);
  }
  const first: [string, string] = by === "warehouse" ? ["label", "Warehouse"] : by === "category" ? ["label", "Category"] : ["label", "SKU"];
  return {
    sections: [{
      columns: [first, ...(by === "variant" ? [["warehouse", "Warehouse"] as [string, string]] : []), ["qty", "Qty"], ["wac", "WAC"], ["value", "Value"]],
      rows, total: { label: "Total", value: s(total) },
    }],
    notes,
  };
}

export async function lowStockRows(ctx: Ctx, f: ReportFilters) {
  const p = await prep(ctx, f);
  const pos = await positions(ctx, p);
  const live = new Set((await db.productVariant.findMany({
    where: { companyId: ctx.companyId, id: { in: [...pos.keys()].map((k) => split(k)[0]) }, status: { in: ["active", "inactive", "draft"] } }, select: { id: true },
  })).map((v) => v.id));
  const hits = [...pos.entries()].flatMap(([k, x]) => {
    const [v, w] = split(k);
    if (!live.has(v)) return [];
    const available = x.onHand.minus(x.reserved);
    const status = available.lte(0) ? "out" : x.reorderPoint && available.lte(x.reorderPoint) ? "low" : null;
    return status ? [{ variantId: v, warehouseId: w, status, x, available }] : [];
  });
  const L = await labels(ctx, hits.map((h) => h.variantId), hits.map((h) => h.warehouseId));
  return hits.map((h) => ({
    sku: L.v(h.variantId).sku, name: L.v(h.variantId).name, warehouse: L.w(h.warehouseId), warehouseId: h.warehouseId, status: h.status as "out" | "low",
    on_hand: s(h.x.onHand), reserved: s(h.x.reserved), available: s(h.available), reorder_point: h.x.reorderPoint ? s(h.x.reorderPoint) : null, reorder_qty: h.x.reorderQty ? s(h.x.reorderQty) : null,
  })).sort((a, b) => (a.status === b.status ? `${a.sku}${a.warehouse}`.localeCompare(`${b.sku}${b.warehouse}`) : a.status === "out" ? -1 : 1));
}

async function lowStock(ctx: Ctx, f: ReportFilters): Promise<{ sections: Section[]; notes: string[] }> {
  const rows = await lowStockRows(ctx, f);
  return {
    sections: [{
      columns: [["status", "Status"], ["sku", "SKU"], ["name", "Name"], ["warehouse", "Warehouse"], ["on_hand", "On hand"], ["reserved", "Reserved"], ["available", "Available"], ["reorder_point", "Reorder point"], ["reorder_qty", "Reorder qty"]],
      rows, total: { status: `${rows.filter((r) => r.status === "out").length} out · ${rows.filter((r) => r.status === "low").length} low` },
    }],
    notes: ["Available = on hand − reserved (an expired batch still on hand counts until the nightly sweep moves it, B-04/B-05)."],
  };
}

async function damaged(ctx: Ctx, f: ReportFilters): Promise<Section[]> {
  const p = await prep(ctx, f);
  const pos = await positions(ctx, p);
  const reasons = await db.inventoryMovement.groupBy({
    by: ["variantId", "warehouseId", "reasonCode"],
    where: { companyId: ctx.companyId, warehouseId: whereWh(p), variantId: whereVar(p), dDamaged: { gt: 0 }, createdAt: f.from || f.to ? { gte: f.from, lte: f.to } : undefined },
    _sum: { dDamaged: true },
  });
  const inPeriod = new Map<string, { qty: Dec; reasons: string[] }>();
  for (const r of reasons) {
    const e = inPeriod.get(key(r)) ?? { qty: dec(0), reasons: [] };
    inPeriod.set(key(r), { qty: e.qty.plus(dec(r._sum.dDamaged)), reasons: [...e.reasons, `${r.reasonCode}: ${s(dec(r._sum.dDamaged))}`] });
  }
  const keys = [...new Set([...[...pos.entries()].filter(([, x]) => x.damaged.gt(0)).map(([k]) => k), ...inPeriod.keys()])];
  const L = await labels(ctx, keys.map((k) => split(k)[0]), keys.map((k) => split(k)[1]));
  let tq = dec(0), tv = dec(0);
  const rows = keys.map((k) => {
    const [v, w] = split(k), x = pos.get(k);
    const qty = x?.damaged ?? dec(0), wac = x ? wacOf(x.costQty, x.value) : dec(0), value = qty.times(wac).toDecimalPlaces(4);
    tq = tq.plus(qty); tv = tv.plus(value);
    return { sku: L.v(v).sku, name: L.v(v).name, warehouse: L.w(w), damaged: s(qty), wac: s(wac), value: s(value), damaged_in_period: s(inPeriod.get(k)?.qty ?? dec(0)), reasons: inPeriod.get(k)?.reasons.join(", ") ?? "" };
  }).sort((a, b) => `${a.sku}${a.warehouse}`.localeCompare(`${b.sku}${b.warehouse}`));
  return [{
    columns: [["sku", "SKU"], ["name", "Name"], ["warehouse", "Warehouse"], ["damaged", "Damaged now"], ["wac", "WAC"], ["value", "Value at WAC"], ["damaged_in_period", "Damaged in period"], ["reasons", "Reasons (period)"]],
    rows, total: { sku: "Total", damaged: s(tq), value: s(tv) },
  }];
}

async function purchasing(ctx: Ctx, f: ReportFilters): Promise<Section[]> {
  const p = await prep(ctx, f);
  const where = { companyId: ctx.companyId, warehouseId: whereWh(p), createdAt: f.from || f.to ? { gte: f.from, lte: f.to } : undefined, ...(p.variantIds ? { lines: { some: { variantId: { in: p.variantIds } } } } : {}) };
  const [byStatus, pos] = await Promise.all([
    db.purchaseOrder.groupBy({ by: ["status", "currency"], where, _count: { _all: true }, _sum: { total: true }, orderBy: [{ status: "asc" }, { currency: "asc" }] }),
    db.purchaseOrder.findMany({
      where: { ...where, status: { notIn: ["draft", "cancelled"] } },
      select: {
        supplierId: true, supplierName: true, orderedAt: true, expectedDate: true,
        lines: { where: { removed: false, ...(p.variantIds ? { variantId: { in: p.variantIds } } : {}) }, select: { qtyOrderedBase: true, qtyReceivedBase: true, qtyReturnedBase: true } },
        receipts: { where: { reversalOfReceiptId: null, reversal: null }, orderBy: { receivedAt: "asc" }, take: 1, select: { receivedAt: true } },
      },
    }),
  ]);
  type Sup = { name: string; pos: number; ordered: Dec; received: Dec; returned: Dec; leadDays: number[]; onTime: number; dated: number };
  const sup = new Map<string, Sup>();
  for (const po of pos) {
    const e = sup.get(po.supplierId) ?? { name: po.supplierName, pos: 0, ordered: dec(0), received: dec(0), returned: dec(0), leadDays: [], onTime: 0, dated: 0 };
    e.pos++;
    for (const l of po.lines) { e.ordered = e.ordered.plus(dec(l.qtyOrderedBase)); e.received = e.received.plus(dec(l.qtyReceivedBase)); e.returned = e.returned.plus(dec(l.qtyReturnedBase)); }
    const first = po.receipts[0]?.receivedAt;
    if (first && po.orderedAt) e.leadDays.push((first.getTime() - po.orderedAt.getTime()) / 86_400_000);
    if (first && po.expectedDate) { e.dated++; if (day(first)! <= day(po.expectedDate)!) e.onTime++; }
    sup.set(po.supplierId, e);
  }
  const pct = (a: Dec, b: Dec) => (b.isZero() ? null : s(a.div(b).times(100).toDecimalPlaces(1)));
  return [
    {
      title: "Purchase orders by status",
      columns: [["status", "Status"], ["currency", "Currency"], ["count", "POs"], ["total", "Total"]],
      rows: byStatus.map((r) => ({ status: r.status, currency: r.currency, count: r._count._all, total: s(dec(r._sum.total).toDecimalPlaces(2)) })),
    },
    {
      title: "Supplier performance",
      columns: [["supplier", "Supplier"], ["pos", "POs"], ["ordered", "Ordered (base)"], ["received", "Received"], ["fill_pct", "Fill %"], ["returned", "Returned"], ["return_pct", "Return %"], ["lead_days", "Avg lead time (days)"], ["on_time_pct", "On time %"]],
      rows: [...sup.values()].sort((a, b) => a.name.localeCompare(b.name)).map((e) => ({
        supplier: e.name, pos: e.pos, ordered: s(e.ordered), received: s(e.received), fill_pct: pct(e.received, e.ordered), returned: s(e.returned), return_pct: pct(e.returned, e.received),
        lead_days: e.leadDays.length ? (e.leadDays.reduce((a, b) => a + b, 0) / e.leadDays.length).toFixed(1) : null, // display only
        on_time_pct: e.dated ? ((e.onTime / e.dated) * 100).toFixed(1) : null,
      })),
    },
  ];
}

async function returns(ctx: Ctx, f: ReportFilters): Promise<Section[]> {
  const p = await prep(ctx, f);
  const period = f.from || f.to ? { gte: f.from, lte: f.to } : undefined;
  const lineFilter = p.variantIds ? { variantId: { in: p.variantIds } } : {};
  const [prs, srs, insp, flows] = await Promise.all([
    db.purchaseReturn.findMany({ where: { companyId: ctx.companyId, warehouseId: whereWh(p), createdAt: period }, select: { status: true, reasonCode: true, lines: { where: lineFilter, select: { qty: true, unitCost: true } } } }),
    db.salesReturn.findMany({ where: { companyId: ctx.companyId, warehouseId: whereWh(p), createdAt: period }, select: { status: true, reasonCode: true, lines: { where: lineFilter, select: { qty: true, qtyRestocked: true, qtyRejected: true, qtyDisposed: true } } } }),
    db.inspection.groupBy({
      by: ["outcome", "disposition"], _count: { _all: true }, _sum: { qty: true }, orderBy: [{ outcome: "asc" }, { disposition: "asc" }],
      where: { companyId: ctx.companyId, warehouseId: whereWh(p), createdAt: period, ...(p.variantIds ? { lot: { variantId: { in: p.variantIds } } } : {}) },
    }),
    db.inventoryMovement.groupBy({
      by: ["type"], _sum: { dOnHand: true, dBlocked: true },
      where: { companyId: ctx.companyId, warehouseId: whereWh(p), variantId: whereVar(p), createdAt: period, type: { in: ["purchase_receipt", "sale_fulfilment", "purchase_return", "sale_return_quarantine"] } },
    }),
  ]);
  const agg = <L,>(docs: { status: string; reasonCode: string; lines: L[] }[], cols: (l: L) => Record<string, Dec>) => {
    const m = new Map<string, { status: string; reason: string; count: number; sums: Record<string, Dec> }>();
    for (const d of docs) {
      if (!d.lines.length) continue;
      const k = `${d.status}|${d.reasonCode}`;
      const e = m.get(k) ?? { status: d.status, reason: d.reasonCode, count: 0, sums: {} };
      e.count++;
      for (const l of d.lines) for (const [c, v] of Object.entries(cols(l))) e.sums[c] = (e.sums[c] ?? dec(0)).plus(v);
      m.set(k, e);
    }
    return [...m.values()].sort((a, b) => `${a.status}${a.reason}`.localeCompare(`${b.status}${b.reason}`)).map((e) => ({ status: e.status, reason: e.reason, count: e.count, ...Object.fromEntries(Object.entries(e.sums).map(([c, v]) => [c, s(v.toDecimalPlaces(4))])) }));
  };
  const flow = (t: string) => { const r = flows.find((x) => x.type === t); return r ? dec(r._sum.dOnHand).plus(dec(r._sum.dBlocked)).abs() : dec(0); };
  const rate = (a: Dec, b: Dec) => (b.isZero() ? null : s(a.div(b).times(100).toDecimalPlaces(1)));
  return [
    { title: "Purchase returns", columns: [["status", "Status"], ["reason", "Reason"], ["count", "Returns"], ["qty", "Qty"], ["value", "Value (linked cost)"]], rows: agg(prs, (l) => ({ qty: dec(l.qty), value: dec(l.qty).times(dec(l.unitCost)) })) },
    { title: "Customer returns", columns: [["status", "Status"], ["reason", "Reason"], ["count", "Returns"], ["qty", "Qty"], ["restocked", "Restocked"], ["written_off", "Rejected / disposed"]], rows: agg(srs, (l) => ({ qty: dec(l.qty), restocked: dec(l.qtyRestocked), written_off: dec(l.qtyRejected).plus(dec(l.qtyDisposed)) })) },
    { title: "Inspection dispositions", columns: [["outcome", "Outcome"], ["disposition", "Disposition"], ["count", "Decisions"], ["qty", "Qty"]], rows: insp.map((r) => ({ outcome: r.outcome, disposition: r.disposition, count: r._count._all, qty: s(dec(r._sum.qty)) })) },
    {
      title: "Return rates (ledger, period)",
      columns: [["flow", "Flow"], ["returned", "Returned"], ["base", "Received / fulfilled"], ["rate_pct", "Rate %"]],
      rows: [
        { flow: "Purchase returns vs receipts", returned: s(flow("purchase_return")), base: s(flow("purchase_receipt")), rate_pct: rate(flow("purchase_return"), flow("purchase_receipt")) },
        { flow: "Customer returns vs fulfilments", returned: s(flow("sale_return_quarantine")), base: s(flow("sale_fulfilment")), rate_pct: rate(flow("sale_return_quarantine"), flow("sale_fulfilment")) },
      ],
    },
  ];
}

export async function inTransitLines(ctx: Ctx, p: Prep) {
  const scopeOr = p.scope ? { OR: [{ fromWarehouseId: { in: p.scope } }, { toWarehouseId: { in: p.scope } }] } : {};
  const lines = await db.transferLine.findMany({
    where: { variantId: whereVar(p), transfer: { companyId: ctx.companyId, status: { in: ["in_transit", "partially_received"] }, ...scopeOr } },
    include: { variant: { select: { sku: true } }, transfer: { include: { fromWarehouse: { select: { code: true } }, toWarehouse: { select: { code: true } } } } },
    orderBy: [{ transfer: { shippedAt: "asc" } }, { lineNo: "asc" }],
  });
  return lines.map((l) => ({
    l, qty: dec(l.qtyShipped).minus(dec(l.qtyReceived)).minus(dec(l.qtyDamaged)).minus(dec(l.qtyMissing)),
    value: dec(l.shippedValue).minus(dec(l.settledValue)),
  })).filter((x) => !x.qty.isZero() || !x.value.isZero());
}

async function transfers(ctx: Ctx, f: ReportFilters): Promise<{ sections: Section[]; notes: string[] }> {
  const p = await prep(ctx, f);
  const now = Date.now();
  const open = await inTransitLines(ctx, p);
  const scopeOr = p.scope ? { OR: [{ fromWarehouseId: { in: p.scope } }, { toWarehouseId: { in: p.scope } }] } : {};
  const variances = await db.transferLine.findMany({
    where: {
      variantId: whereVar(p), OR: [{ qtyDamaged: { gt: 0 } }, { qtyMissing: { gt: 0 } }, { qtyMissingReported: { gt: 0 } }],
      transfer: { companyId: ctx.companyId, ...scopeOr, shippedAt: f.from || f.to ? { gte: f.from, lte: f.to } : undefined },
    },
    include: { variant: { select: { sku: true } }, transfer: { select: { number: true, status: true } } },
    orderBy: [{ transferId: "asc" }, { lineNo: "asc" }],
  });
  const total = open.reduce((t, x) => t.plus(x.value), dec(0));
  return {
    sections: [
      {
        title: "In transit",
        columns: [["number", "Transfer"], ["route", "From → to"], ["shipped_at", "Shipped"], ["days", "Days in transit"], ["sku", "SKU"], ["shipped", "Shipped"], ["received", "Received"], ["damaged", "Damaged"], ["missing", "Missing (approved)"], ["reported", "Missing (reported)"], ["in_transit", "In transit"], ["value", "Value in transit"]],
        rows: open.map(({ l, qty, value }) => ({
          number: l.transfer.number, route: `${l.transfer.fromWarehouse.code} → ${l.transfer.toWarehouse.code}`, shipped_at: day(l.transfer.shippedAt),
          days: l.transfer.shippedAt ? Math.floor((now - l.transfer.shippedAt.getTime()) / 86_400_000) : null, sku: l.variant.sku,
          shipped: s(dec(l.qtyShipped)), received: s(dec(l.qtyReceived)), damaged: s(dec(l.qtyDamaged)), missing: s(dec(l.qtyMissing)), reported: s(dec(l.qtyMissingReported)), in_transit: s(qty), value: s(value),
        })),
        total: { number: "Total in transit", value: s(total) },
      },
      {
        title: "Variances (damaged / missing in transit)",
        columns: [["number", "Transfer"], ["status", "Status"], ["sku", "SKU"], ["shipped", "Shipped"], ["damaged", "Damaged"], ["missing", "Missing (approved)"], ["reported", "Missing (reported)"]],
        rows: variances.map((l) => ({ number: l.transfer.number, status: l.transfer.status, sku: l.variant.sku, shipped: s(dec(l.qtyShipped)), damaged: s(dec(l.qtyDamaged)), missing: s(dec(l.qtyMissing)), reported: s(dec(l.qtyMissingReported)) })),
      },
    ],
    notes: ["Value in transit is the in-transit line of the valuation report (shipped value − value settled at the destination)."],
  };
}

async function movement(ctx: Ctx, f: ReportFilters): Promise<Section[]> {
  const p = await prep(ctx, f);
  // Physical units per movement row (bucket-to-bucket moves net to 0); putaways move
  // within a warehouse, reservations aren't physical — both skipped.
  const rows = await db.$queryRaw<{ variant_id: string; warehouse_id: string; qin: string; qout: string; net: string; n: number }[]>`
    SELECT variant_id, warehouse_id, SUM(GREATEST(q, 0))::text qin, SUM(LEAST(q, 0))::text qout, SUM(q)::text net, COUNT(*)::int n
    FROM (
      SELECT variant_id, warehouse_id, d_on_hand + d_blocked + d_damaged + d_expired q FROM inventory_movement
      WHERE company_id = ${ctx.companyId} AND type::text NOT IN ('putaway_out', 'putaway_in')
        AND (${p.scope}::text[] IS NULL OR warehouse_id = ANY(${p.scope}::text[]))
        AND (${p.variantIds}::text[] IS NULL OR variant_id = ANY(${p.variantIds}::text[]))
        AND (${f.from ?? null}::timestamp IS NULL OR created_at >= ${f.from ?? null}::timestamp)
        AND (${f.to ?? null}::timestamp IS NULL OR created_at <= ${f.to ?? null}::timestamp)
    ) m WHERE q <> 0
    GROUP BY variant_id, warehouse_id`;
  const L = await labels(ctx, rows.map((r) => r.variant_id), rows.map((r) => r.warehouse_id));
  let ti = dec(0), to = dec(0);
  const out = rows.map((r) => {
    ti = ti.plus(r.qin); to = to.plus(r.qout);
    return { sku: L.v(r.variant_id).sku, name: L.v(r.variant_id).name, warehouse: L.w(r.warehouse_id), qty_in: s(dec(r.qin)), qty_out: s(dec(r.qout).neg()), net: s(dec(r.net)), movements: r.n };
  }).sort((a, b) => `${a.sku}${a.warehouse}`.localeCompare(`${b.sku}${b.warehouse}`));
  return [{
    columns: [["sku", "SKU"], ["name", "Name"], ["warehouse", "Warehouse"], ["qty_in", "In"], ["qty_out", "Out"], ["net", "Net"], ["movements", "Movements"]],
    rows: out, total: { sku: "Total", qty_in: s(ti), qty_out: s(to.neg()), net: s(ti.plus(to)) },
  }];
}

export async function runReport(ctx: Ctx, name: ReportName, filters: ReportFilters): Promise<Report> {
  const f = filters; // parsed by the caller (ReportFilters)
  const r = await ({
    summary, ledger, valuation, "low-stock": lowStock, damaged, purchasing, returns, transfers, movement,
  } satisfies Record<ReportName, (ctx: Ctx, f: ReportFilters) => Promise<Section[] | { sections: Section[]; notes: string[] }>>)[name](ctx, f);
  const { sections, notes } = Array.isArray(r) ? { sections: r, notes: [] } : r;
  return { name, title: REPORTS[name].title, sections, notes };
}

// Doc 16 export (CSV; Excel opens it — native .xlsx export is deferred, as in Part 8).
export async function exportReport(ctx: Ctx, name: ReportName, filters: ReportFilters) {
  await requirePermission(ctx, "reports.export", { warehouseId: filters.warehouseId });
  const r = await runReport(ctx, name, filters);
  const grid: Cell[][] = [];
  for (const sec of r.sections) {
    if (grid.length) grid.push([]);
    if (sec.title) grid.push([sec.title]);
    grid.push(sec.columns.map(([, label]) => label));
    for (const row of [...sec.rows, ...(sec.total ? [sec.total] : [])]) grid.push(sec.columns.map(([k]) => row[k] ?? ""));
  }
  for (const n of r.notes) grid.push([], [n]);
  const rowCount = r.sections.reduce((t, sec) => t + sec.rows.length, 0);
  await writeAudit(db, ctx, {
    action: "export", entityType: "report", entityId: name, warehouseId: filters.warehouseId ?? null,
    after: { filters, scope: ctx.warehouseIds, rowCount, format: "csv" },
  });
  return { csv: toCsv(grid), rowCount, fileName: `${name}-${new Date().toISOString().slice(0, 10)}.csv` };
}

