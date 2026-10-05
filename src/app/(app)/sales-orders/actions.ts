"use server";

import type { SalesChannel } from "@/generated/prisma/client";
import { bool, clearable, str, version } from "@/app/ui/form";
import { runAction, type ActionState } from "@/server/auth/page-ctx";
import { variantByCode } from "@/server/catalog/catalog";
import type { Ctx } from "@/server/core/ctx";
import type { Tx } from "@/server/db";
import { cancel, cancelOrder, extend, fulfil, posSale, reserve } from "@/server/inventory/reservations";

// New reservation, or (sell now) a POS immediate sale. `key` is rendered into the form,
// so a double submit replays instead of reserving twice.
export async function reserveAction(key: string, _: ActionState, f: FormData): Promise<ActionState> {
  const sellNow = bool(f, "sellNow");
  return runAction(sellNow ? "pos_sales.create" : "reservations.create", async (tx, ctx) => {
    const input = {
      variantId: await variantByCode(ctx, str(f, "sku") ?? ""), warehouseId: str(f, "warehouseId") ?? "", qty: str(f, "qty") ?? "0",
      externalOrderId: str(f, "externalOrderId"), channel: (str(f, "channel") ?? "pos") as SalesChannel,
    };
    return sellNow ? posSale(tx, ctx, input) : reserve(tx, ctx, { ...input, allowPartial: bool(f, "allowPartial") });
  }, sellNow ? "Sold" : "Reserved", undefined, key);
}

const MOVES = {
  fulfil: (tx, ctx, id, f) => fulfil(tx, ctx, { reservationId: id, version: version(f), qty: str(f, "qty") }),
  cancel: (tx, ctx, id, f) => cancel(tx, ctx, { reservationId: id, version: version(f), reason: str(f, "reason") }),
  extend: (tx, ctx, id, f) => extend(tx, ctx, { reservationId: id, version: version(f) }),
} satisfies Record<string, (tx: Tx, ctx: Ctx, id: string, f: FormData) => Promise<unknown>>;

export async function reservationAction(id: string, move: keyof typeof MOVES, _: ActionState, f: FormData): Promise<ActionState> {
  return runAction(`reservations.${move}`, (tx, ctx) => MOVES[move](tx, ctx, id, f), { fulfil: "Shipped", cancel: "Cancelled", extend: "Extended" }[move]);
}

export async function cancelOrderAction(orderId: string, _: ActionState, f: FormData): Promise<ActionState> {
  return runAction("sales_orders.cancel", (tx, ctx) => cancelOrder(tx, ctx, { orderId, reason: clearable(f, "reason") ?? undefined }), "Order cancelled");
}
