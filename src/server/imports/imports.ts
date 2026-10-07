import { createHash } from "node:crypto";
import type { ImportType, Prisma } from "@/generated/prisma/client";
import { createProduct, variantByCode } from "@/server/catalog/catalog";
import { toAppError } from "@/server/core/api";
import { writeAudit } from "@/server/core/audit";
import { requirePermission, scopeFilter, type Ctx } from "@/server/core/ctx";
import { AppError, assertVersion } from "@/server/core/errors";
import { db, transaction, type Tx } from "@/server/db";
import { createAdjustment, submitAdjustment, type AdjustmentLineInput } from "@/server/inventory/adjustments";
import { parseBool, parseDate, readTable, toCsv } from "./files";

// Flow 20 (import, two-phase) + flow 21 (export). Preview is a dry run of confirm in a
// rolled-back transaction, so its row errors are exactly what confirm would hit (edge #14).

export type ImportMode = "all_or_nothing" | "valid_only";
type Row = Record<string, string> & { row: string };
type RowError = { row: number; message: string };

const COLUMNS: Record<ImportType, { required: string[]; optional: string[] }> = {
  products: { required: ["sku", "name"], optional: ["barcode", "base_uom", "requires_batch", "requires_expiry", "is_serialized", "cost_price", "sell_price", "min_sell_price"] },
  opening_balance: { required: ["sku", "qty", "unit_cost"], optional: ["bin", "batch_no", "expiry_date", "serials"] },
};

class Rollback extends Error {}

type Job = { type: ImportType; warehouseId: string | null; asOf: Date | null };

// Runs the rows. strict: the first error throws (confirm). Otherwise (preview) each row
// runs under a savepoint, so a row the DB rejects doesn't abort the others.
async function run(tx: Tx, ctx: Ctx, job: Job, rows: Row[], strict: boolean) {
  const errors: RowError[] = [];
  const fail = async (row: number, e: unknown) => {
    const err = toAppError(e);
    if (strict) throw new AppError(err.code, `Row ${row}: ${err.message}`, { row, ...(err.details && typeof err.details === "object" ? err.details : {}) });
    await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT import_row");
    errors.push({ row, message: err.message });
  };
  const mark = () => (strict ? Promise.resolve(0) : tx.$executeRawUnsafe("SAVEPOINT import_row"));
  if (job.type === "products") {
    const created: string[] = [];
    for (const r of rows) {
      try {
        await mark();
        const p = await createProduct(tx, ctx, {
          name: r.name, baseUom: r.base_uom || undefined, requiresBatch: parseBool(r.requires_batch), requiresExpiry: parseBool(r.requires_expiry), isSerialized: parseBool(r.is_serialized),
          variants: [{ sku: r.sku, barcode: r.barcode || null, costPrice: r.cost_price || null, sellPrice: r.sell_price || null, minSellPrice: r.min_sell_price || null }],
        });
        created.push(p.id);
      } catch (e) {
        await fail(Number(r.row), e);
      }
    }
    return { errors, result: { productIds: created } };
  }

  const lines: (AdjustmentLineInput & { row: number })[] = [];
  const bins = await tx.bin.findMany({ where: { companyId: ctx.companyId, warehouseId: job.warehouseId!, archived: false } });
  for (const r of rows) {
    try {
      await mark();
      const bin = r.bin ? bins.find((b) => b.code === r.bin.toUpperCase() || b.code === r.bin) : null;
      if (r.bin && !bin) throw new AppError("validation_error", `Unknown bin ${r.bin}`, { field: "bin" });
      const line = {
        row: Number(r.row), variantId: await variantByCode(ctx, r.sku), qty: r.qty, unitCost: r.unit_cost, binId: bin?.id ?? null,
        batchNo: r.batch_no || null, expiryDate: parseDate(r.expiry_date) ?? null, serials: (r.serials ?? "").split(/[\s,;]+/).filter(Boolean),
      };
      if (!/^\d{1,14}(\.\d{1,4})?$/.test(line.qty) || Number(line.qty) <= 0) throw new AppError("validation_error", "qty must be > 0 with ≤ 4 decimals", { field: "qty" });
      if (!/^\d{1,14}(\.\d{1,4})?$/.test(line.unitCost)) throw new AppError("validation_error", "unit_cost must be ≥ 0 with ≤ 4 decimals", { field: "unit_cost" });
      if (!strict) await createAdjustment(tx, ctx, { kind: "opening", warehouseId: job.warehouseId!, reasonCode: "opening", asOf: job.asOf, lines: [line] }); // row check only
      lines.push(line);
    } catch (e) {
      await fail(Number(r.row), e);
    }
  }
  if (errors.length || !lines.length) return { errors, result: null };
  try {
    await mark();
    // One document for the file: cross-row rules (duplicate serials) are checked here.
    const doc = await createAdjustment(tx, ctx, { kind: "opening", warehouseId: job.warehouseId!, reasonCode: "opening", note: "Imported", asOf: job.asOf, lines });
    const sub = await submitAdjustment(tx, ctx, { id: doc.id, version: doc.version });
    return { errors, result: { adjustmentId: doc.id, number: doc.number, status: sub.status } };
  } catch (e) {
    await fail(0, e);
    return { errors, result: null };
  }
}

export async function previewImport(
  ctx: Ctx,
  input: { type: ImportType; fileName: string; bytes: Uint8Array; warehouseId?: string | null; asOf?: Date | null },
) {
  await requirePermission(ctx, "imports.run", { warehouseId: input.warehouseId });
  if (input.type === "opening_balance" && !input.warehouseId) throw new AppError("validation_error", "Choose the warehouse", { field: "warehouseId" });
  const fileName = input.fileName.replace(/[^\w.\- ]/g, "_").slice(-200);
  const table = readTable(fileName, input.bytes);
  const cols = COLUMNS[input.type];
  const missing = cols.required.filter((c) => !table.header.includes(c));
  if (missing.length) throw new AppError("validation_error", `Missing column(s): ${missing.join(", ")}`, { field: "file", missing, expected: [...cols.required, ...cols.optional] });
  const rows: Row[] = table.rows.map((r, i) => ({ ...r, row: String(i + 2) })); // row 1 is the header
  const job: Job = { type: input.type, warehouseId: input.warehouseId ?? null, asOf: input.asOf ?? null };

  let errors: RowError[] = [];
  await transaction(async (tx) => {
    errors = (await run(tx, ctx, job, rows, false)).errors;
    throw new Rollback();
  }).catch((e) => { if (!(e instanceof Rollback)) throw e; });

  return transaction(async (tx) => {
    const created = await tx.importJob.create({
      data: {
        companyId: ctx.companyId, type: input.type, fileName, fileSha256: createHash("sha256").update(input.bytes).digest("hex"), fileSize: input.bytes.byteLength,
        warehouseId: job.warehouseId, asOf: job.asOf, rows: rows as Prisma.InputJsonValue, errors: errors as Prisma.InputJsonValue,
        rowCount: rows.length, errorCount: new Set(errors.map((e) => e.row)).size, createdBy: ctx.userId,
      },
    });
    await writeAudit(tx, ctx, {
      action: "import.preview", entityType: "import_job", entityId: created.id, warehouseId: job.warehouseId,
      after: { type: created.type, fileName, fileSha256: created.fileSha256, rowCount: created.rowCount, errorCount: created.errorCount },
    });
    return created;
  });
}

export async function confirmImport(ctx: Ctx, input: { id: string; version: number; mode?: ImportMode }) {
  await requirePermission(ctx, "imports.run");
  const mode: ImportMode = input.mode ?? "all_or_nothing";
  const lock = async (tx: Tx) => {
    await tx.$executeRaw`SELECT 1 FROM import_job WHERE id = ${input.id} AND company_id = ${ctx.companyId} FOR UPDATE`;
    const j = await tx.importJob.findFirst({ where: { id: input.id, companyId: ctx.companyId } });
    if (!j) throw new AppError("not_found", "Import not found");
    if (j.version !== input.version) throw new AppError("version_conflict", "Import was changed by someone else", { currentVersion: j.version });
    if (j.status !== "previewed") throw new AppError("invalid_transition", `Import is already ${j.status}`, { from: j.status, to: "completed" });
    await requirePermission(ctx, "imports.run", { warehouseId: j.warehouseId });
    return j;
  };
  const finish = (tx: Tx, status: "completed" | "failed", result: unknown, errors?: RowError[]) =>
    tx.importJob.updateMany({
      where: { id: input.id, version: input.version, status: "previewed" },
      data: {
        status, mode, result: result as Prisma.InputJsonValue, confirmedBy: ctx.userId, confirmedAt: new Date(), version: { increment: 1 },
        ...(errors ? { errors: errors as Prisma.InputJsonValue, errorCount: new Set(errors.map((e) => e.row)).size } : {}),
      },
    }).then((r) => assertVersion(r, "Import", input.version));

  try {
    return await transaction(async (tx) => {
      const j = await lock(tx);
      const bad = new Set((j.errors as RowError[]).map((e) => e.row));
      if (mode === "all_or_nothing" && bad.size) throw new AppError("validation_error", `${bad.size} row(s) have errors; fix the file or confirm valid rows only`, { field: "mode" });
      const rows = (j.rows as Row[]).filter((r) => !bad.has(Number(r.row)));
      if (!rows.length) throw new AppError("validation_error", "No valid rows to import", { field: "file" });
      const { result } = await run(tx, ctx, j, rows, true);
      await finish(tx, "completed", { ...result, imported: rows.length, skipped: bad.size });
      await writeAudit(tx, ctx, { action: "import.confirm", entityType: "import_job", entityId: j.id, warehouseId: j.warehouseId, after: { mode, imported: rows.length, skipped: bad.size, result } });
      return tx.importJob.findUniqueOrThrow({ where: { id: j.id } });
    });
  } catch (e) {
    const err = toAppError(e);
    if (["not_found", "version_conflict", "invalid_transition", "forbidden"].includes(err.code)) throw err;
    if (err.code === "validation_error" && (err.details as { field?: string } | undefined)?.field === "mode") throw err;
    // Everything rolled back; the history keeps the failed attempt (all-or-nothing).
    const row = (err.details as { row?: number } | undefined)?.row ?? 0;
    await transaction(async (tx) => {
      await lock(tx);
      await finish(tx, "failed", { error: err.message, code: err.code }, [{ row, message: err.message }]);
      await writeAudit(tx, ctx, { action: "import.failed", entityType: "import_job", entityId: input.id, after: { mode, code: err.code, message: err.message, row } });
    });
    throw err;
  }
}

export async function cancelImport(tx: Tx, ctx: Ctx, input: { id: string; version: number }) {
  await requirePermission(ctx, "imports.run");
  assertVersion(await tx.importJob.updateMany({
    where: { id: input.id, companyId: ctx.companyId, version: input.version, status: "previewed" },
    data: { status: "cancelled", version: { increment: 1 } },
  }), "Import", input.version);
  await writeAudit(tx, ctx, { action: "cancel", entityType: "import_job", entityId: input.id });
  return tx.importJob.findUniqueOrThrow({ where: { id: input.id } });
}

export async function listImports(ctx: Ctx, input: { page: number; perPage: number }) {
  await requirePermission(ctx, "imports.run");
  const where = { companyId: ctx.companyId };
  const [total, items] = await Promise.all([
    db.importJob.count({ where }),
    db.importJob.findMany({
      where, orderBy: { createdAt: "desc" }, skip: (input.page - 1) * input.perPage, take: input.perPage,
      omit: { rows: true }, include: { creator: { select: { name: true } } },
    }),
  ]);
  return { total, page: input.page, perPage: input.perPage, items };
}

export async function getImport(ctx: Ctx, id: string) {
  await requirePermission(ctx, "imports.run");
  const j = await db.importJob.findFirst({ where: { id, companyId: ctx.companyId }, include: { creator: { select: { name: true } } } });
  if (!j) throw new AppError("not_found", "Import not found");
  return { ...j, rows: j.rows as Row[], errors: j.errors as RowError[] };
}

// Flow 21: stock balances per bin/batch as CSV, limited to the caller's warehouses; audited.
export async function exportStock(ctx: Ctx, input: { warehouseId?: string } = {}) {
  await requirePermission(ctx, "reports.export");
  await requirePermission(ctx, "inventory.view", { warehouseId: input.warehouseId });
  const rows = await db.stockBalance.findMany({
    where: {
      companyId: ctx.companyId, warehouseId: scopeFilter(ctx, input.warehouseId),
      OR: [{ onHand: { not: 0 } }, { blocked: { not: 0 } }, { damaged: { not: 0 } }, { expired: { not: 0 } }],
    },
    include: {
      warehouse: { select: { code: true } }, bin: { select: { code: true } },
      variant: { select: { sku: true, name: true, product: { select: { name: true } } } }, batch: { select: { batchNo: true, expiryDate: true } },
    },
    orderBy: [{ warehouseId: "asc" }, { binId: "asc" }, { variantId: "asc" }],
  });
  const csv = toCsv([
    ["warehouse", "bin", "sku", "name", "batch_no", "expiry_date", "on_hand", "blocked", "damaged", "expired"],
    ...rows.map((r) => [
      r.warehouse.code, r.bin.code, r.variant.sku, r.variant.name ?? r.variant.product.name, r.batch?.batchNo ?? "", r.batch?.expiryDate?.toISOString().slice(0, 10) ?? "",
      r.onHand.toString(), r.blocked.toString(), r.damaged.toString(), r.expired.toString(),
    ]),
  ]);
  await writeAudit(db, ctx, {
    action: "export", entityType: "stock_balance", entityId: input.warehouseId ?? "scope", warehouseId: input.warehouseId ?? null,
    after: { filters: { warehouseId: input.warehouseId ?? null, scope: ctx.warehouseIds }, rowCount: rows.length, format: "csv" },
  });
  return { csv, rowCount: rows.length, fileName: `stock-${new Date().toISOString().slice(0, 10)}.csv` };
}
