"use server";

import { bool, clearable, str, version } from "@/app/ui/form";
import { runAction, type ActionState } from "@/server/auth/page-ctx";
import { variantByCode as variantBySku } from "@/server/catalog/catalog";
import type { Ctx } from "@/server/core/ctx";
import {
  approvePo, cancelPo, closePo, createPo, orderPo, reducePoLine, rejectPo, submitPo, updatePo, type PoLineInput,
} from "@/server/purchasing/purchase-orders";
import { decideExcess, postReceipt, reverseReceipt, type ReceiptLineInput } from "@/server/purchasing/receipts";

// Line rows are named line.<i>.<field>; empty rows are skipped.
async function poLines(ctx: Ctx, f: FormData): Promise<PoLineInput[]> {
  const lines: PoLineInput[] = [];
  for (let i = 0; f.has(`line.${i}.sku`); i++) {
    const sku = str(f, `line.${i}.sku`);
    if (!sku) continue;
    lines.push({
      id: str(f, `line.${i}.id`), variantId: await variantBySku(ctx, sku), qty: str(f, `line.${i}.qty`) ?? "0",
      uom: str(f, `line.${i}.uom`), unitPrice: str(f, `line.${i}.unitPrice`), discountPct: str(f, `line.${i}.discountPct`), taxPct: str(f, `line.${i}.taxPct`),
    });
  }
  return lines;
}

const header = (f: FormData) => {
  const d = str(f, "expectedDate");
  return { expectedDate: d ? new Date(d) : null, notes: clearable(f, "notes"), discount: str(f, "discount"), tax: str(f, "tax"), shipping: str(f, "shipping") };
};

export async function createPoAction(_: ActionState, f: FormData): Promise<ActionState> {
  return runAction("purchase_orders.create", async (tx, ctx) => createPo(tx, ctx, {
    ...header(f), supplierId: str(f, "supplierId") ?? "", warehouseId: str(f, "warehouseId") ?? "", lines: await poLines(ctx, f),
  }), "Created", (po) => `/purchase-orders/${po.id}`);
}

export async function updatePoAction(id: string, _: ActionState, f: FormData): Promise<ActionState> {
  return runAction("purchase_orders.update", async (tx, ctx) => updatePo(tx, ctx, {
    ...header(f), id, version: version(f), supplierId: str(f, "supplierId"), lines: await poLines(ctx, f),
  }));
}

const MOVES = { submit: submitPo, approve: approvePo, order: orderPo } as const;
export async function poMoveAction(id: string, move: keyof typeof MOVES, _: ActionState, f: FormData): Promise<ActionState> {
  return runAction(`purchase_orders.${move}`, (tx, ctx) => MOVES[move](tx, ctx, { id, version: version(f), comment: clearable(f, "comment") }), "Done");
}

export async function rejectPoAction(id: string, _: ActionState, f: FormData): Promise<ActionState> {
  return runAction("purchase_orders.reject", (tx, ctx) => rejectPo(tx, ctx, { id, version: version(f), comment: str(f, "comment") ?? "" }), "Sent back to draft");
}

export async function closePoAction(id: string, _: ActionState, f: FormData): Promise<ActionState> {
  return runAction("purchase_orders.close", (tx, ctx) => closePo(tx, ctx, { id, version: version(f), reason: clearable(f, "reason") }), "Closed");
}

export async function cancelPoAction(id: string, _: ActionState, f: FormData): Promise<ActionState> {
  return runAction("purchase_orders.cancel", (tx, ctx) => cancelPo(tx, ctx, { id, version: version(f), reason: clearable(f, "reason") }), "Cancelled");
}

export async function reduceLineAction(poId: string, lineId: string, _: ActionState, f: FormData): Promise<ActionState> {
  return runAction("purchase_orders.reduce_line", (tx, ctx) => reducePoLine(tx, ctx, { poId, lineId, version: version(f), qty: str(f, "qty") ?? "0" }), "Reduced");
}

// Receiving form rows: rcv.<i>.* per PO line, wrong.<i>.* for items that weren't ordered.
export async function receiveAction(poId: string, key: string, _: ActionState, f: FormData): Promise<ActionState> {
  return runAction("receipts.create", async (tx, ctx) => {
    const list = (k: string) => (str(f, k) ?? "").split(/[\s,]+/).filter(Boolean);
    const date = (k: string) => (str(f, k) ? new Date(str(f, k)!) : undefined);
    const lines: ReceiptLineInput[] = [];
    for (let i = 0; f.has(`rcv.${i}.poLineId`); i++) {
      const p = `rcv.${i}.`;
      const qtys = { accepted: str(f, p + "accepted"), damaged: str(f, p + "damaged"), expired: str(f, p + "expired"), missing: str(f, p + "missing") };
      if (!Object.values(qtys).some((q) => q && Number(q) > 0)) continue;
      lines.push({
        poLineId: str(f, p + "poLineId"), ...qtys, binId: str(f, p + "binId"), batchNo: str(f, p + "batchNo"),
        expiryDate: date(p + "expiryDate"), serials: list(p + "serials"), damagedSerials: list(p + "damagedSerials"), note: str(f, p + "note"),
      });
    }
    for (let i = 0; f.has(`wrong.${i}.sku`); i++) {
      const p = `wrong.${i}.`;
      const sku = str(f, p + "sku");
      if (!sku) continue;
      lines.push({
        variantId: await variantBySku(ctx, sku), qty: str(f, p + "qty"), held: bool(f, p + "held"),
        batchNo: str(f, p + "batchNo"), expiryDate: date(p + "expiryDate"), serials: list(p + "serials"), note: str(f, p + "note"),
      });
    }
    return postReceipt(tx, ctx, { poId, supplierRef: clearable(f, "supplierRef"), note: clearable(f, "note"), lines }, key);
  }, "Received", () => `/purchase-orders/${poId}`, key);
}

export async function reverseReceiptAction(receiptId: string, _: ActionState, f: FormData): Promise<ActionState> {
  return runAction("receipts.reverse", (tx, ctx) => reverseReceipt(tx, ctx, { receiptId, reason: str(f, "reason") ?? "" }), "Reversed");
}

export async function excessAction(receiptLineId: string, _: ActionState, f: FormData): Promise<ActionState> {
  return runAction("receipts.excess", (tx, ctx) => decideExcess(tx, ctx, {
    receiptLineId, approve: f.get("decision") === "approve", comment: clearable(f, "comment"),
  }), "Decided");
}
