"use server";

import type { AdjustmentKind } from "@/generated/prisma/client";
import { clearable, str, version } from "@/app/ui/form";
import { runAction, type ActionState } from "@/server/auth/page-ctx";
import { batchByNo, variantByCode } from "@/server/catalog/catalog";
import { AppError } from "@/server/core/errors";
import { db } from "@/server/db";
import {
  applyAdjustment, approveAdjustment, cancelAdjustment, createAdjustment, rejectAdjustment, submitAdjustment,
  type AdjustmentLineInput,
} from "@/server/inventory/adjustments";

const KINDS: AdjustmentKind[] = ["adjustment", "damage", "repair", "disposal"];
const BUCKETS = ["damaged", "expired", "blocked"] as const;

// Rows line.<i>.*; bins are typed by code within the chosen warehouse.
export async function createAdjustmentAction(_: ActionState, f: FormData): Promise<ActionState> {
  return runAction("adjustments.create", async (tx, ctx) => {
    const kind = KINDS.find((k) => k === str(f, "kind")) ?? "adjustment";
    const warehouseId = str(f, "warehouseId") ?? "";
    const lines: AdjustmentLineInput[] = [];
    for (let i = 0; f.has(`line.${i}.sku`); i++) {
      const p = `line.${i}.`;
      const sku = str(f, p + "sku");
      if (!sku) continue;
      const variantId = await variantByCode(ctx, sku);
      const binCode = str(f, p + "bin");
      const bin = binCode ? await db.bin.findFirst({ where: { companyId: ctx.companyId, warehouseId, code: binCode } }) : null;
      if (binCode && !bin) throw new AppError("validation_error", `Unknown bin ${binCode}`, { field: "binId" });
      lines.push({
        variantId, qty: str(f, p + "qty") ?? "0", batchId: await batchByNo(ctx, variantId, str(f, p + "batchNo")), binId: bin?.id ?? null,
        bucket: kind === "disposal" ? (BUCKETS.find((b) => b === str(f, p + "bucket")) ?? "damaged") : null,
        unitCost: str(f, p + "unitCost") ?? null, serials: (str(f, p + "serials") ?? "").split(/[\s,]+/).filter(Boolean),
      });
    }
    return createAdjustment(tx, ctx, { kind, warehouseId, reasonCode: str(f, "reasonCode") ?? "", note: clearable(f, "note"), lines });
  }, "Created", (a) => `/adjustments/${a.id}`);
}

const MOVES = { submit: submitAdjustment, approve: approveAdjustment, apply: applyAdjustment, cancel: cancelAdjustment } as const;
// approve (damage/repair/disposal) and apply post stock: the key rendered into the form makes a double submit replay.
export async function adjMoveAction(id: string, move: keyof typeof MOVES, key: string | undefined, _: ActionState, f: FormData): Promise<ActionState> {
  return runAction(`adjustments.${move}`, (tx, ctx) => MOVES[move](tx, ctx, { id, version: version(f), comment: clearable(f, "comment") }), "Done", undefined, key);
}

export async function rejectAdjustmentAction(id: string, _: ActionState, f: FormData): Promise<ActionState> {
  return runAction("adjustments.reject", (tx, ctx) => rejectAdjustment(tx, ctx, { id, version: version(f), comment: str(f, "comment") ?? "" }), "Sent back to draft");
}
