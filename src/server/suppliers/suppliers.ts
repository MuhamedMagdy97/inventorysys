import { Prisma, type AddressType, type MasterStatus, type PaymentTerms } from "@/generated/prisma/client";
import { writeAudit } from "@/server/core/audit";
import { requirePermission, type Ctx } from "@/server/core/ctx";
import { AppError, assertVersion } from "@/server/core/errors";
import { nextNumber } from "@/server/core/sequences";
import { db, type Tx } from "@/server/db";
import { OPEN_PO } from "@/server/purchasing/purchase-orders";

// Doc 05. Lifecycle active ↔ inactive → archived (terminal).

export type SupplierInput = {
  name: string;
  taxId?: string | null;
  paymentTerms?: PaymentTerms;
  creditLimit?: Prisma.Decimal | string | number | null;
  currency?: string;
  leadTimeDays?: number | null;
  notes?: string | null;
  requiresInspection?: boolean;
  receiptTolerancePct?: Prisma.Decimal | string | number | null;
};

function fields(input: Partial<SupplierInput>) {
  const name = input.name?.trim();
  if (name !== undefined && (name.length < 2 || name.length > 200)) throw new AppError("validation_error", "Name: 2–200 characters", { field: "name" });
  if (input.currency !== undefined && !/^[A-Z]{3}$/.test(input.currency)) throw new AppError("validation_error", "Currency: ISO 4217 code", { field: "currency" });
  const cl = input.creditLimit;
  const creditLimit = cl === undefined ? undefined : cl === null || cl === "" ? null : new Prisma.Decimal(cl);
  if (creditLimit?.isNeg()) throw new AppError("validation_error", "Credit limit must be ≥ 0", { field: "creditLimit" });
  if (input.leadTimeDays != null && (!Number.isInteger(input.leadTimeDays) || input.leadTimeDays < 0)) {
    throw new AppError("validation_error", "Lead time: whole days ≥ 0", { field: "leadTimeDays" });
  }
  return {
    name, currency: input.currency, paymentTerms: input.paymentTerms, creditLimit, leadTimeDays: input.leadTimeDays,
    taxId: input.taxId === undefined ? undefined : input.taxId?.trim() || null,
    notes: input.notes === undefined ? undefined : input.notes?.trim() || null,
    requiresInspection: input.requiresInspection, receiptTolerancePct: tolerance(input.receiptTolerancePct),
  };
}

// PO-10: per-supplier receipt tolerance %, null = company setting.
function tolerance(v: SupplierInput["receiptTolerancePct"]) {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const d = new Prisma.Decimal(v);
  if (d.isNeg() || d.gt(100) || d.decimalPlaces() > 2) throw new AppError("validation_error", "Receipt tolerance: 0–100 %", { field: "receiptTolerancePct" });
  return d;
}

async function findSupplier(tx: Tx | typeof db, ctx: Ctx, id: string) {
  const s = await tx.supplier.findFirst({ where: { id, companyId: ctx.companyId } });
  if (!s) throw new AppError("not_found", "Supplier not found");
  return s;
}

const editable = async (tx: Tx, ctx: Ctx, id: string) => {
  await requirePermission(ctx, "suppliers.update");
  const s = await findSupplier(tx, ctx, id);
  if (s.status === "archived") throw new AppError("archived_conflict", "Supplier is archived");
  return s;
};

// Flow 4. Code SUP-0001… from the per-company sequence; currency defaults to the company's.
export async function createSupplier(tx: Tx, ctx: Ctx, input: SupplierInput) {
  await requirePermission(ctx, "suppliers.create");
  const currency = input.currency ?? (await tx.company.findUniqueOrThrow({ where: { id: ctx.companyId } })).currency;
  const data = fields({ ...input, currency });
  const supplier = await tx.supplier.create({
    data: { ...data, name: data.name!, currency, companyId: ctx.companyId, code: await nextNumber(tx, ctx.companyId, "supplier", "SUP-") },
  });
  await writeAudit(tx, ctx, { action: "create", entityType: "supplier", entityId: supplier.id, after: supplier });
  return supplier;
}

const NEXT: Record<MasterStatus, MasterStatus[]> = { active: ["inactive", "archived"], inactive: ["active", "archived"], archived: [] };

export async function updateSupplier(tx: Tx, ctx: Ctx, input: Partial<SupplierInput> & { id: string; version: number; status?: MasterStatus }) {
  await requirePermission(ctx, input.status === "archived" ? "suppliers.archive" : "suppliers.update");
  const before = await findSupplier(tx, ctx, input.id);
  if (input.status && input.status !== before.status && !NEXT[before.status].includes(input.status)) {
    throw new AppError("invalid_transition", `Supplier can't go from ${before.status} to ${input.status}`, { from: before.status, to: input.status });
  }
  if (before.status === "archived") throw new AppError("archived_conflict", "Supplier is archived");
  if (input.status === "archived") { // SUP-01 (edge #4)
    const open = await tx.purchaseOrder.count({ where: { supplierId: before.id, status: { in: OPEN_PO } } });
    if (open) throw new AppError("conflict", `Close or cancel the ${open} open PO(s) first (SUP-01)`, { reason: "open_pos", count: open });
  }
  assertVersion(await tx.supplier.updateMany({
    where: { id: before.id, version: input.version },
    data: { ...fields(input), status: input.status, version: { increment: 1 } },
  }), "Supplier", before.version);
  const after = await tx.supplier.findUniqueOrThrow({ where: { id: before.id } });
  await writeAudit(tx, ctx, { action: input.status === "archived" ? "archive" : "update", entityType: "supplier", entityId: after.id, before, after });
  return after;
}

// ───────────── Contacts, addresses (never deleted; "remove" archives) ─────────────

export async function addSupplierContact(
  tx: Tx,
  ctx: Ctx,
  input: { supplierId: string; name: string; role?: string | null; email?: string | null; phone?: string | null; isPrimary?: boolean },
) {
  const s = await editable(tx, ctx, input.supplierId);
  const name = input.name.trim();
  if (!name) throw new AppError("validation_error", "Contact name is required", { field: "name" });
  if (input.email && !/^[^\s@]+@[^\s@]+$/.test(input.email)) throw new AppError("validation_error", "Invalid email", { field: "email" });
  if (input.isPrimary) await tx.supplierContact.updateMany({ where: { supplierId: s.id }, data: { isPrimary: false } });
  const contact = await tx.supplierContact.create({
    data: { supplierId: s.id, name, role: input.role?.trim() || null, email: input.email?.trim() || null, phone: input.phone?.trim() || null, isPrimary: !!input.isPrimary },
  });
  await writeAudit(tx, ctx, { action: "contact_add", entityType: "supplier", entityId: s.id, after: contact });
  return contact;
}

export async function addSupplierAddress(
  tx: Tx,
  ctx: Ctx,
  input: { supplierId: string; type: AddressType; line1: string; line2?: string | null; city: string; postalCode?: string | null; country: string },
) {
  const s = await editable(tx, ctx, input.supplierId);
  if (!input.line1.trim() || !input.city.trim() || !input.country.trim()) {
    throw new AppError("validation_error", "Address line, city and country are required");
  }
  const address = await tx.supplierAddress.create({
    data: {
      supplierId: s.id, type: input.type, line1: input.line1.trim(), line2: input.line2?.trim() || null,
      city: input.city.trim(), postalCode: input.postalCode?.trim() || null, country: input.country.trim(),
    },
  });
  await writeAudit(tx, ctx, { action: "address_add", entityType: "supplier", entityId: s.id, after: address });
  return address;
}

export async function archiveSupplierChild(tx: Tx, ctx: Ctx, input: { supplierId: string; kind: "contact" | "address"; id: string }) {
  const s = await editable(tx, ctx, input.supplierId);
  const where = { id: input.id, supplierId: s.id };
  const res = input.kind === "contact"
    ? await tx.supplierContact.updateMany({ where, data: { archived: true, isPrimary: false } })
    : await tx.supplierAddress.updateMany({ where, data: { archived: true } });
  if (!res.count) throw new AppError("not_found", `${input.kind} not found`);
  await writeAudit(tx, ctx, { action: `${input.kind}_archive`, entityType: "supplier", entityId: s.id, after: { id: input.id } });
}

// ───────────── Supplier products (SUP-03: last price is informational) ─────────────

export async function setSupplierProduct(
  tx: Tx,
  ctx: Ctx,
  input: {
    supplierId: string; variantId: string; supplierSku?: string | null; lastPrice?: string | number | null;
    minOrderQty?: string | number | null; leadDays?: number | null; isPreferred?: boolean;
  },
) {
  const s = await editable(tx, ctx, input.supplierId);
  const variant = await tx.productVariant.findFirst({ where: { id: input.variantId, companyId: ctx.companyId } });
  if (!variant) throw new AppError("not_found", "Variant not found");
  const dec = (v: string | number | null | undefined, field: string, min: "gte" | "gt") => {
    if (v === undefined || v === null || v === "") return null;
    const d = new Prisma.Decimal(v);
    if (min === "gte" ? d.isNeg() : d.lte(0)) throw new AppError("validation_error", `${field} out of range`, { field });
    return d;
  };
  const data = {
    supplierSku: input.supplierSku?.trim() || null, lastPrice: dec(input.lastPrice, "lastPrice", "gte"),
    minOrderQty: dec(input.minOrderQty, "minOrderQty", "gt"), leadDays: input.leadDays ?? null, isPreferred: !!input.isPreferred,
  };
  // One preferred supplier per variant.
  if (data.isPreferred) await tx.supplierProduct.updateMany({ where: { variantId: variant.id, supplierId: { not: s.id } }, data: { isPreferred: false } });
  const key = { supplierId_variantId: { supplierId: s.id, variantId: variant.id } };
  const before = await tx.supplierProduct.findUnique({ where: key });
  const after = await tx.supplierProduct.upsert({ where: key, create: { supplierId: s.id, variantId: variant.id, ...data }, update: data });
  await writeAudit(tx, ctx, { action: "product_link", entityType: "supplier", entityId: s.id, before, after });
  return after;
}

// ponytail: URL only — uploads with allowlist/size caps come in Part 8.
export async function addSupplierDocument(tx: Tx, ctx: Ctx, input: { supplierId: string; type: string; fileUrl: string }) {
  const s = await editable(tx, ctx, input.supplierId);
  if (!/^https:\/\/\S{1,2000}$/.test(input.fileUrl)) throw new AppError("validation_error", "Document URL must be https://", { field: "fileUrl" });
  const doc = await tx.supplierDocument.create({ data: { supplierId: s.id, type: input.type.trim() || "other", fileUrl: input.fileUrl, uploadedBy: ctx.userId } });
  await writeAudit(tx, ctx, { action: "document_add", entityType: "supplier", entityId: s.id, after: doc });
  return doc;
}

// ───────────── Reads ─────────────

export async function listSuppliers(ctx: Ctx, input: { page: number; perPage: number; q?: string; status?: MasterStatus }) {
  await requirePermission(ctx, "suppliers.view");
  const q = input.q?.trim();
  const where: Prisma.SupplierWhereInput = {
    companyId: ctx.companyId,
    status: input.status ?? { not: "archived" },
    ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { code: { contains: q.toUpperCase() } }] } : {}),
  };
  const [total, items] = await Promise.all([
    db.supplier.count({ where }),
    db.supplier.findMany({
      where, orderBy: { code: "asc" }, skip: (input.page - 1) * input.perPage, take: input.perPage,
      include: { _count: { select: { products: true } }, contacts: { where: { isPrimary: true, archived: false }, take: 1 } },
    }),
  ]);
  return { total, page: input.page, perPage: input.perPage, items };
}

export async function getSupplier(ctx: Ctx, id: string) {
  await requirePermission(ctx, "suppliers.view");
  const s = await db.supplier.findFirst({
    where: { id, companyId: ctx.companyId },
    include: {
      contacts: { where: { archived: false }, orderBy: [{ isPrimary: "desc" }, { name: "asc" }] },
      addresses: { where: { archived: false }, orderBy: { type: "asc" } },
      documents: { orderBy: { uploadedAt: "desc" } },
      products: { include: { variant: { select: { id: true, sku: true, name: true, productId: true, product: { select: { name: true } } } } } },
    },
  });
  if (!s) throw new AppError("not_found", "Supplier not found");
  return s;
}
