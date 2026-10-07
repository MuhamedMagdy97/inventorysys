"use server";

import { clearable, str, version } from "@/app/ui/form";
import { runAction, type ActionState } from "@/server/auth/page-ctx";
import { batchByNo, variantByCode } from "@/server/catalog/catalog";
import {
  approvePurchaseReturn, cancelPurchaseReturn, closePurchaseReturn, confirmPurchaseReturn, createPurchaseReturn, rejectPurchaseReturn,
  shipPurchaseReturn, submitPurchaseReturn, supplierRejectPurchaseReturn, type PurchaseReturnLineInput, type ReturnBucket,
} from "@/server/returns/purchase-returns";
import {
  approveSalesReturn, cancelSalesReturn, createSalesReturn, receiveSalesReturn, rejectSalesReturn, type SalesReturnLineInput,
} from "@/server/returns/sales-returns";

const BUCKETS: ReturnBucket[] = ["onHand", "blocked", "damaged", "expired"];
const list = (s: string | undefined) => (s ?? "").split(/[\s,]+/).filter(Boolean);

// ───── purchase returns ─────

// Rows line.<i>.*; lots default oldest receipt first (edge #35).
export async function createPurchaseReturnAction(_: ActionState, f: FormData): Promise<ActionState> {
  return runAction("purchase_returns.create", async (tx, ctx) => {
    const lines: PurchaseReturnLineInput[] = [];
    for (let i = 0; f.has(`line.${i}.sku`); i++) {
      const p = `line.${i}.`;
      const sku = str(f, p + "sku");
      if (!sku) continue;
      const variantId = await variantByCode(ctx, sku);
      lines.push({
        variantId, qty: str(f, p + "qty") ?? "0", batchId: await batchByNo(ctx, variantId, str(f, p + "batchNo")),
        bucket: BUCKETS.find((b) => b === str(f, p + "bucket")) ?? "onHand", serials: list(str(f, p + "serials")),
      });
    }
    return createPurchaseReturn(tx, ctx, { poId: str(f, "poId") ?? "", reasonCode: str(f, "reasonCode") ?? "", note: clearable(f, "note"), lines });
  }, "Created", (r) => `/returns/purchase/${r.id}`);
}

const PR_MOVES = { submit: submitPurchaseReturn, approve: approvePurchaseReturn, cancel: cancelPurchaseReturn, close: closePurchaseReturn } as const;
export async function prMoveAction(id: string, move: keyof typeof PR_MOVES, _: ActionState, f: FormData): Promise<ActionState> {
  return runAction(`purchase_returns.${move}`, (tx, ctx) => PR_MOVES[move](tx, ctx, { id, version: version(f), comment: clearable(f, "comment") }), "Done");
}
export async function prRejectAction(id: string, _: ActionState, f: FormData): Promise<ActionState> {
  return runAction("purchase_returns.reject", (tx, ctx) => rejectPurchaseReturn(tx, ctx, { id, version: version(f), comment: str(f, "comment") ?? "" }), "Sent back to draft");
}
// Stock postings carry the rendered key, so a double submit replays.
export async function prShipAction(id: string, key: string, _: ActionState, f: FormData): Promise<ActionState> {
  const lines = [...f.keys()].filter((k) => k.startsWith("lot.")).map((k) => ({ lineId: k.slice(4), receiptLineId: String(f.get(k)) }));
  return runAction("purchase_returns.ship", (tx, ctx) => shipPurchaseReturn(tx, ctx, { id, version: version(f), lines }), "Shipped", undefined, key);
}
export async function prConfirmAction(id: string, _: ActionState, f: FormData): Promise<ActionState> {
  return runAction("purchase_returns.confirm", (tx, ctx) => confirmPurchaseReturn(tx, ctx, { id, version: version(f), creditNoteRef: clearable(f, "creditNoteRef") }), "Confirmed");
}
export async function prSupplierRejectAction(id: string, key: string, _: ActionState, f: FormData): Promise<ActionState> {
  return runAction("purchase_returns.supplier_reject", (tx, ctx) => supplierRejectPurchaseReturn(tx, ctx, { id, version: version(f), note: str(f, "note") ?? "" }), "Back in quarantine", undefined, key);
}

// ───── sales returns ─────

// One row per returnable order line: qty.<reservationId>, serials.<reservationId>.
export async function createSalesReturnAction(_: ActionState, f: FormData): Promise<ActionState> {
  return runAction("sales_returns.create", (tx, ctx) => {
    const lines: SalesReturnLineInput[] = [...f.keys()].filter((k) => k.startsWith("qty.") && str(f, k)).map((k) => {
      const reservationId = k.slice(4);
      return { reservationId, qty: str(f, k)!, serials: list(str(f, `serials.${reservationId}`)) };
    });
    return createSalesReturn(tx, ctx, { reasonCode: str(f, "reasonCode") ?? "", note: clearable(f, "note"), lines });
  }, "Created", (r) => `/returns/sales/${r.id}`);
}

const SR_MOVES = { approve: approveSalesReturn, cancel: cancelSalesReturn } as const;
export async function srMoveAction(id: string, move: keyof typeof SR_MOVES, _: ActionState, f: FormData): Promise<ActionState> {
  return runAction(`sales_returns.${move}`, (tx, ctx) => SR_MOVES[move](tx, ctx, { id, version: version(f), comment: clearable(f, "comment") }), "Done");
}
export async function srRejectAction(id: string, _: ActionState, f: FormData): Promise<ActionState> {
  return runAction("sales_returns.reject", (tx, ctx) => rejectSalesReturn(tx, ctx, { id, version: version(f), comment: str(f, "comment") ?? "" }), "Rejected");
}
// received.<lineId>, expiry.<lineId> (SR-03 inspection batch when the original has expired).
export async function srReceiveAction(id: string, key: string, _: ActionState, f: FormData): Promise<ActionState> {
  const lines = [...f.keys()].filter((k) => k.startsWith("received.")).map((k) => {
    const lineId = k.slice(9);
    const exp = str(f, `expiry.${lineId}`);
    return { lineId, qty: str(f, k) ?? "0", expiryDate: exp ? new Date(exp) : null };
  });
  return runAction("sales_returns.receive", (tx, ctx) => receiveSalesReturn(tx, ctx, { id, version: version(f), lines }), "Received into quarantine", undefined, key);
}
