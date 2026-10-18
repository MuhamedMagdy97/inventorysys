import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { requirePermission, type Ctx } from "@/server/core/ctx";
import { AppError } from "@/server/core/errors";
import { db } from "@/server/db";
import { getReceipt } from "@/server/purchasing/receipts";
import { visible } from "@/server/warehouses/warehouses";
import { code128, ean13, isEan13 } from "./barcode";

// Doc 25 "Barcode labels": read-only label data for the /labels print page.
export const MAX_IDS = 200;
export const MAX_LABELS = 2000;

export const LabelQuery = z.object({
  kind: z.enum(["variant", "bin", "batch", "receipt"]),
  ids: z.string().default("").transform((s) => [...new Set(s.split(",").map((x) => x.trim()).filter(Boolean))]).pipe(z.array(z.string().max(64)).max(MAX_IDS)),
  warehouse: z.string().max(64).optional(), // bins: every active bin of this warehouse
  copies: z.coerce.number().int().min(1).max(100).default(1),
  layout: z.enum(["a4", "thermal"]).default("a4"),
  price: z.literal("1").optional(),
});
export type LabelInput = z.infer<typeof LabelQuery>;

export type Label = { value: string; modules: string; title: string; lines: string[] };

function bar(value: string): Pick<Label, "value" | "modules"> {
  try {
    return { value, modules: isEan13(value) ? ean13(value) : code128(value) };
  } catch {
    throw new AppError("validation_error", `“${value}” can’t be printed as a barcode (printable ASCII only)`);
  }
}

const variantSel = { id: true, sku: true, barcode: true, name: true, sellPrice: true, product: { select: { name: true } } } satisfies Prisma.ProductVariantSelect;
const batchSel = { id: true, batchNo: true, expiryDate: true, mfgDate: true, variant: { select: variantSel } } satisfies Prisma.BatchSelect;
type V = Prisma.ProductVariantGetPayload<{ select: typeof variantSel }>;
type B = Prisma.BatchGetPayload<{ select: typeof batchSel }>;

const day = (d: Date | null) => d?.toISOString().slice(0, 10);
const title = (v: V) => (v.name ? `${v.product.name} · ${v.name}` : v.product.name);

const variantLabel = (v: V, currency: string | null): Label => ({
  ...bar(v.barcode || v.sku), title: title(v),
  lines: [v.sku, ...(currency && v.sellPrice ? [`${v.sellPrice.toFixed(2)} ${currency}`] : [])],
});
const batchLabel = (b: B): Label => ({
  ...bar(b.batchNo), title: title(b.variant),
  lines: [b.variant.sku, ...(b.expiryDate ? [`EXP ${day(b.expiryDate)}`] : []), ...(b.mfgDate ? [`MFG ${day(b.mfgDate)}`] : [])],
});

const ordered = <T extends { id: string }>(rows: T[], ids: string[]) => {
  if (rows.length !== ids.length) throw new AppError("not_found", "Some records were not found");
  return ids.map((id) => rows.find((r) => r.id === id)!);
};

function capped(n: number) {
  if (n > MAX_LABELS) throw new AppError("validation_error", `At most ${MAX_LABELS} labels per page`, { labels: n });
}

export async function getLabels(ctx: Ctx, input: LabelInput): Promise<Label[]> {
  const { kind, ids } = input;
  if (!ids.length && !(kind === "bin" && input.warehouse)) throw new AppError("validation_error", "Nothing to print");
  let labels: Label[] = [];

  if (kind === "variant") await requirePermission(ctx, "products.view");
  const currency = input.price
    ? (await db.company.findUniqueOrThrow({ where: { id: ctx.companyId }, select: { currency: true } })).currency
    : null;

  if (kind === "variant") {
    const rows = await db.productVariant.findMany({ where: { companyId: ctx.companyId, id: { in: ids } }, select: variantSel });
    labels = ordered(rows, ids).map((v) => variantLabel(v, currency));
  } else if (kind === "batch") {
    await requirePermission(ctx, "inventory.view");
    const scope = ctx.warehouseIds === "all" ? {} : { stockBalances: { some: { warehouseId: { in: ctx.warehouseIds } } } };
    const rows = await db.batch.findMany({ where: { companyId: ctx.companyId, id: { in: ids }, ...scope }, select: batchSel });
    labels = ordered(rows, ids).map(batchLabel);
  } else if (kind === "bin") {
    await requirePermission(ctx, "warehouses.view");
    const rows = await db.bin.findMany({
      where: {
        companyId: ctx.companyId, warehouse: visible(ctx),
        ...(ids.length ? { id: { in: ids } } : { warehouseId: input.warehouse, archived: false }),
      },
      orderBy: [{ zone: "asc" }, { rack: "asc" }, { shelf: "asc" }, { code: "asc" }],
      select: { id: true, code: true, zone: true, rack: true, shelf: true, warehouse: { select: { code: true } } },
    });
    if (!rows.length || (ids.length && rows.length !== ids.length)) throw new AppError("not_found", "Some bins were not found");
    labels = rows.map((b) => ({ ...bar(b.code), title: b.warehouse.code, lines: [[b.zone, b.rack, b.shelf].filter(Boolean).join(" › ")].filter(Boolean) }));
  } else {
    // One label per unit kept in stock; batch lines get batch labels (doc 25).
    for (const id of ids) {
      await getReceipt(ctx, id); // company + permission + scope
      const lines = await db.receiptLine.findMany({
        where: { receiptId: id }, orderBy: { lineNo: "asc" },
        select: { qtyAccepted: true, qtyExcessBlocked: true, variant: { select: variantSel }, batch: { select: batchSel } },
      });
      for (const l of lines) {
        const qty = l.qtyAccepted.add(l.qtyExcessBlocked);
        if (qty.lte(0)) continue;
        const n = qty.isInteger() ? qty.toNumber() : 1;
        capped(labels.length + n);
        const label = l.batch ? batchLabel(l.batch) : variantLabel(l.variant, currency);
        labels.push(...Array<Label>(n).fill(label));
      }
    }
  }

  capped(labels.length * input.copies);
  return labels.flatMap((l) => Array<Label>(input.copies).fill(l));
}
