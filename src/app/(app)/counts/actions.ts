"use server";

import { clearable, str, version } from "@/app/ui/form";
import { runAction, type ActionState } from "@/server/auth/page-ctx";
import { batchByNo, variantByCode } from "@/server/catalog/catalog";
import { AppError } from "@/server/core/errors";
import { db } from "@/server/db";
import { applyCount, approveCount, cancelCount, enterCounts, openCount, recountCount, submitCount, type CountEntry } from "@/server/inventory/counts";

const serials = (s: string | undefined) => (s ?? "").split(/[\s,;]+/).filter(Boolean);

// New count: warehouse + optional bin code + optional SKU list (scope).
export async function openCountAction(_: ActionState, f: FormData): Promise<ActionState> {
  return runAction("counts.open", async (tx, ctx) => {
    const warehouseId = str(f, "warehouseId") ?? "";
    const binCode = str(f, "bin");
    const bin = binCode ? await db.bin.findFirst({ where: { companyId: ctx.companyId, warehouseId, code: binCode.toUpperCase() } }) : null;
    if (binCode && !bin) throw new AppError("validation_error", `Unknown bin ${binCode}`, { field: "binId" });
    const variantIds = await Promise.all((str(f, "skus") ?? "").split(/[\s,;]+/).filter(Boolean).map((c) => variantByCode(ctx, c)));
    return openCount(tx, ctx, { warehouseId, binId: bin?.id ?? null, variantIds, note: clearable(f, "note") });
  }, "Opened", (c) => `/counts/${c.id}`);
}

// Count sheet: qty.<lineId> / serials.<lineId>, plus one "found" row typed or scanned by code.
export async function enterCountsAction(id: string, warehouseId: string, _: ActionState, f: FormData): Promise<ActionState> {
  return runAction("counts.entries", async (tx, ctx) => {
    const entries: CountEntry[] = [];
    for (const [k, v] of f.entries()) {
      if (typeof v !== "string" || !v.trim()) continue;
      if (k.startsWith("qty.")) entries.push({ lineId: k.slice(4), countedQty: v.trim() });
      if (k.startsWith("serials.")) entries.push({ lineId: k.slice(8), serials: serials(v) });
    }
    const code = str(f, "found.code");
    if (code) {
      const variantId = await variantByCode(ctx, code);
      const bin = await db.bin.findFirst({ where: { companyId: ctx.companyId, warehouseId, code: (str(f, "found.bin") ?? "").toUpperCase() } });
      if (!bin) throw new AppError("validation_error", "Bin code for the found item?", { field: "binId" });
      const s = serials(str(f, "found.serials"));
      entries.push({ binId: bin.id, variantId, batchId: await batchByNo(ctx, variantId, str(f, "found.batchNo")), ...(s.length ? { serials: s } : { countedQty: str(f, "found.qty") ?? "0" }) });
    }
    return enterCounts(tx, ctx, { id, entries });
  }, "Counts saved");
}

const MOVES = { submit: submitCount, approve: approveCount, apply: applyCount, cancel: cancelCount } as const;
// apply posts stock: the key rendered into the form makes a double submit replay.
export async function countMoveAction(id: string, move: keyof typeof MOVES, key: string | undefined, _: ActionState, f: FormData): Promise<ActionState> {
  return runAction(`counts.${move}`, (tx, ctx) => MOVES[move](tx, ctx, { id, version: version(f), comment: clearable(f, "comment") }), "Done", undefined, key);
}

export async function recountAction(id: string, _: ActionState, f: FormData): Promise<ActionState> {
  return runAction("counts.recount", (tx, ctx) => recountCount(tx, ctx, { id, version: version(f), lineIds: f.getAll("lineId").map(String) }), "Sent back for recount");
}
