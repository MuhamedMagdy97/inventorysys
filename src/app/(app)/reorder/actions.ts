"use server";

import { bool, str } from "@/app/ui/form";
import { runAction, type ActionState } from "@/server/auth/page-ctx";
import { createReorderPos, type ReorderLine } from "@/server/purchasing/reorder";

// Rows are named row.<i>.<field>; only ticked rows (pick.<i>) become PO lines (RO-05).
export async function createReorderPosAction(_: ActionState, f: FormData): Promise<ActionState> {
  const lines: ReorderLine[] = [];
  for (let i = 0; f.has(`row.${i}.variantId`); i++) {
    if (!bool(f, `pick.${i}`)) continue;
    lines.push({
      variantId: str(f, `row.${i}.variantId`) ?? "", warehouseId: str(f, `row.${i}.warehouseId`) ?? "",
      supplierId: str(f, `row.${i}.supplierId`) ?? "", qty: str(f, `row.${i}.qty`) ?? "0",
    });
  }
  return runAction("reorder.create_pos", (tx, ctx) => createReorderPos(tx, ctx, { lines }), "Created",
    (pos) => (pos.length === 1 ? `/purchase-orders/${pos[0].id}` : "/purchase-orders?status=draft"));
}
