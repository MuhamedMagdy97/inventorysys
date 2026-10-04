import type { UomType } from "@/generated/prisma/client";
import { writeAudit } from "@/server/core/audit";
import { requirePermission, type Ctx } from "@/server/core/ctx";
import { AppError, assertVersion } from "@/server/core/errors";
import { db, type Tx } from "@/server/db";

// ───────────── UOM (doc 04 §2) ─────────────

// Same list as the Part 3 migration's backfill.
export const DEFAULT_UOMS: { code: string; name: string; type: UomType }[] = [
  { code: "each", name: "Each", type: "count" }, { code: "pack", name: "Pack", type: "count" },
  { code: "box", name: "Box", type: "count" }, { code: "case", name: "Case", type: "count" },
  { code: "kg", name: "Kilogram", type: "weight" }, { code: "g", name: "Gram", type: "weight" },
  { code: "l", name: "Litre", type: "volume" }, { code: "ml", name: "Millilitre", type: "volume" },
  { code: "m", name: "Metre", type: "length" }, { code: "cm", name: "Centimetre", type: "length" },
];

export async function seedUoms(tx: Tx, companyId: string) {
  await tx.uom.createMany({ data: DEFAULT_UOMS.map((u) => ({ ...u, companyId })), skipDuplicates: true });
}

export async function listUoms(ctx: Ctx) {
  await requirePermission(ctx, ["products.view", "uom.manage"]);
  return db.uom.findMany({ where: { companyId: ctx.companyId }, orderBy: [{ type: "asc" }, { code: "asc" }] });
}

export async function createUom(tx: Tx, ctx: Ctx, input: { code: string; name: string; type: UomType }) {
  await requirePermission(ctx, "uom.manage");
  const code = input.code.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_]{0,15}$/.test(code)) throw new AppError("validation_error", "UOM code: lower-case letters/digits, max 16", { field: "code" });
  const uom = await tx.uom.create({ data: { companyId: ctx.companyId, code, name: input.name.trim(), type: input.type } });
  await writeAudit(tx, ctx, { action: "create", entityType: "uom", entityId: code, after: uom });
  return uom;
}

// ───────────── Categories (doc 04 §6) ─────────────

const MAX_DEPTH = 5;

// Tree changes are serialised per company, so two concurrent moves can't build a cycle.
const lockTree = (tx: Tx, companyId: string) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`category-tree:${companyId}`}))`;

function categoryName(name: string) {
  const n = name.trim();
  if (n.length < 1 || n.length > 100 || n.includes("/")) {
    throw new AppError("validation_error", "Category name: 1–100 characters, no '/'", { field: "name" });
  }
  return n;
}

async function findCategory(tx: Tx, ctx: Ctx, id: string) {
  const c = await tx.category.findFirst({ where: { id, companyId: ctx.companyId } });
  if (!c) throw new AppError("not_found", "Category not found");
  return c;
}

async function activeParent(tx: Tx, ctx: Ctx, parentId: string | null | undefined) {
  if (!parentId) return null;
  const p = await findCategory(tx, ctx, parentId);
  if (p.archived) throw new AppError("archived_conflict", "Parent category is archived");
  return p;
}

export async function listCategories(ctx: Ctx, opts: { includeArchived?: boolean } = {}) {
  await requirePermission(ctx, ["products.view", "categories.manage"]);
  return db.category.findMany({
    where: { companyId: ctx.companyId, ...(opts.includeArchived ? {} : { archived: false }) },
    orderBy: { path: "asc" }, // path order = depth-first tree order
    include: { _count: { select: { products: true } } },
  });
}

export async function createCategory(tx: Tx, ctx: Ctx, input: { name: string; parentId?: string | null }) {
  await requirePermission(ctx, "categories.manage");
  await lockTree(tx, ctx.companyId);
  const name = categoryName(input.name);
  const parent = await activeParent(tx, ctx, input.parentId);
  const depth = (parent?.depth ?? 0) + 1;
  if (depth > MAX_DEPTH) throw new AppError("validation_error", `Categories nest at most ${MAX_DEPTH} levels`, { field: "parentId" });
  const category = await tx.category.create({
    data: { companyId: ctx.companyId, parentId: parent?.id ?? null, name, depth, path: `${parent?.path ?? "/"}${name}/` },
  });
  await writeAudit(tx, ctx, { action: "create", entityType: "category", entityId: category.id, after: category });
  return category;
}

// Rename and/or move (parentId null = make root). Edge #24: a parent that is the
// category itself or one of its descendants is rejected. Descendant paths/depths follow.
export async function updateCategory(
  tx: Tx,
  ctx: Ctx,
  input: { id: string; version: number; name?: string; parentId?: string | null },
) {
  await requirePermission(ctx, "categories.manage");
  await lockTree(tx, ctx.companyId);
  const before = await findCategory(tx, ctx, input.id);
  if (before.archived) throw new AppError("archived_conflict", "Category is archived");
  const name = input.name === undefined ? before.name : categoryName(input.name);
  const parentId = input.parentId === undefined ? before.parentId : input.parentId;
  const parent = await activeParent(tx, ctx, parentId);
  // Sibling names are unique, so `path` is unique and a prefix test finds descendants.
  if (parent && (parent.id === before.id || parent.path.startsWith(before.path))) {
    throw new AppError("validation_error", "A category cannot move under itself or its own descendant", { field: "parentId", reason: "cycle" });
  }
  const depth = (parent?.depth ?? 0) + 1;
  const [{ max }] = await tx.$queryRaw<{ max: number }[]>`
    SELECT max(depth)::int AS max FROM category
    WHERE company_id = ${ctx.companyId} AND left(path, length(${before.path})) = ${before.path}`;
  if (max - before.depth + depth > MAX_DEPTH) {
    throw new AppError("validation_error", `Categories nest at most ${MAX_DEPTH} levels`, { field: "parentId" });
  }
  const path = `${parent?.path ?? "/"}${name}/`;
  assertVersion(await tx.category.updateMany({
    where: { id: before.id, version: input.version },
    data: { name, parentId: parent?.id ?? null, depth, path, version: { increment: 1 } },
  }), "Category", before.version);
  await tx.$executeRaw`
    UPDATE category SET path = ${path} || substr(path, length(${before.path}) + 1), depth = depth + ${depth - before.depth}
    WHERE company_id = ${ctx.companyId} AND id <> ${before.id} AND left(path, length(${before.path})) = ${before.path}`;
  const after = await tx.category.findUniqueOrThrow({ where: { id: before.id } });
  await writeAudit(tx, ctx, { action: before.parentId !== after.parentId ? "move" : "update", entityType: "category", entityId: after.id, before, after });
  return after;
}

// Archive cascades to the subtree and is blocked while any non-archived product sits
// in it (doc 04 §6). Re-activation needs an active parent.
export async function setCategoryArchived(tx: Tx, ctx: Ctx, input: { id: string; version: number; archived: boolean }) {
  await requirePermission(ctx, "categories.manage");
  await lockTree(tx, ctx.companyId);
  const before = await findCategory(tx, ctx, input.id);
  const subtree = { companyId: ctx.companyId, path: { startsWith: before.path } };
  if (input.archived) {
    const products = await tx.product.count({ where: { companyId: ctx.companyId, status: { not: "archived" }, category: subtree } });
    if (products) throw new AppError("conflict", `Move the ${products} product(s) in this category (or its subcategories) first`, { reason: "has_products", products });
  } else if (before.parentId) {
    await activeParent(tx, ctx, before.parentId);
  }
  assertVersion(await tx.category.updateMany({
    where: { id: before.id, version: input.version }, data: { archived: input.archived, version: { increment: 1 } },
  }), "Category", before.version);
  if (input.archived) await tx.category.updateMany({ where: { ...subtree, archived: false }, data: { archived: true, version: { increment: 1 } } });
  await writeAudit(tx, ctx, { action: input.archived ? "archive" : "unarchive", entityType: "category", entityId: before.id, before, after: { archived: input.archived } });
}

// Merge = move every product to `intoId`, then archive the loser (doc 04 §6). The
// moved product ids are in the audit row, so a merge is undone by moving them back.
export async function mergeCategory(tx: Tx, ctx: Ctx, input: { fromId: string; intoId: string }) {
  await requirePermission(ctx, "categories.manage");
  await lockTree(tx, ctx.companyId);
  const from = await findCategory(tx, ctx, input.fromId);
  const into = await activeParent(tx, ctx, input.intoId);
  if (!into || into.id === from.id) throw new AppError("validation_error", "Pick a different target category");
  if (await tx.category.count({ where: { parentId: from.id, archived: false } })) {
    throw new AppError("conflict", "Merge or move the subcategories first", { reason: "has_children" });
  }
  const moved = await tx.product.findMany({ where: { categoryId: from.id }, select: { id: true } });
  await tx.product.updateMany({ where: { categoryId: from.id }, data: { categoryId: into.id, version: { increment: 1 } } });
  await tx.category.update({ where: { id: from.id }, data: { archived: true, version: { increment: 1 } } });
  await writeAudit(tx, ctx, {
    action: "merge", entityType: "category", entityId: from.id,
    before: { categoryId: from.id, productIds: moved.map((p) => p.id) }, after: { categoryId: into.id },
  });
  return { moved: moved.length };
}

// ───────────── Brands (doc 04 §7) ─────────────

export async function listBrands(ctx: Ctx, opts: { includeArchived?: boolean } = {}) {
  await requirePermission(ctx, ["products.view", "brands.manage"]);
  return db.brand.findMany({
    where: { companyId: ctx.companyId, ...(opts.includeArchived ? {} : { archived: false }) },
    orderBy: { name: "asc" },
    include: { _count: { select: { products: true } } },
  });
}

const brandName = (name: string) => {
  const n = name.trim();
  if (n.length < 1 || n.length > 100) throw new AppError("validation_error", "Brand name: 1–100 characters", { field: "name" });
  return n;
};

export async function createBrand(tx: Tx, ctx: Ctx, input: { name: string; logoUrl?: string | null }) {
  await requirePermission(ctx, "brands.manage");
  const brand = await tx.brand.create({ data: { companyId: ctx.companyId, name: brandName(input.name), logoUrl: input.logoUrl ?? null } });
  await writeAudit(tx, ctx, { action: "create", entityType: "brand", entityId: brand.id, after: brand });
  return brand;
}

// Archive/re-activate any time; products keep their brand_id for history.
export async function updateBrand(
  tx: Tx,
  ctx: Ctx,
  input: { id: string; version: number; name?: string; logoUrl?: string | null; archived?: boolean },
) {
  await requirePermission(ctx, "brands.manage");
  const before = await tx.brand.findFirst({ where: { id: input.id, companyId: ctx.companyId } });
  if (!before) throw new AppError("not_found", "Brand not found");
  assertVersion(await tx.brand.updateMany({
    where: { id: before.id, version: input.version },
    data: {
      name: input.name === undefined ? undefined : brandName(input.name),
      logoUrl: input.logoUrl, archived: input.archived, version: { increment: 1 },
    },
  }), "Brand", before.version);
  const after = await tx.brand.findUniqueOrThrow({ where: { id: before.id } });
  const action = input.archived === undefined || input.archived === before.archived ? "update" : input.archived ? "archive" : "unarchive";
  await writeAudit(tx, ctx, { action, entityType: "brand", entityId: after.id, before, after });
  return after;
}
