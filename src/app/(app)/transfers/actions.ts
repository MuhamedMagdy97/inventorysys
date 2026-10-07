"use server";

import { clearable, str, version } from "@/app/ui/form";
import { runAction, type ActionState } from "@/server/auth/page-ctx";
import { batchByNo, variantByCode } from "@/server/catalog/catalog";
import {
  approveTransfer, cancelTransfer, createTransfer, decideVariance, receiveTransfer, rejectTransfer, shipTransfer, submitTransfer,
  type ReceiveLineInput, type ShipLineInput, type TransferLineInput,
} from "@/server/inventory/transfers";

const list = (f: FormData, k: string) => (str(f, k) ?? "").split(/[\s,]+/).filter(Boolean);

export async function createTransferAction(_: ActionState, f: FormData): Promise<ActionState> {
  return runAction("transfers.create", async (tx, ctx) => {
    const lines: TransferLineInput[] = [];
    for (let i = 0; f.has(`line.${i}.sku`); i++) {
      const sku = str(f, `line.${i}.sku`);
      if (!sku) continue;
      const variantId = await variantByCode(ctx, sku);
      lines.push({ variantId, qty: str(f, `line.${i}.qty`) ?? "0", batchId: await batchByNo(ctx, variantId, str(f, `line.${i}.batchNo`)) });
    }
    return createTransfer(tx, ctx, { fromWarehouseId: str(f, "fromWarehouseId") ?? "", toWarehouseId: str(f, "toWarehouseId") ?? "", notes: clearable(f, "notes"), lines });
  }, "Created", (t) => `/transfers/${t.id}`);
}

const MOVES = { submit: submitTransfer, approve: approveTransfer, cancel: cancelTransfer } as const;
export async function transferMoveAction(id: string, move: keyof typeof MOVES, _: ActionState, f: FormData): Promise<ActionState> {
  return runAction(`transfers.${move}`, (tx, ctx) => MOVES[move](tx, ctx, { id, version: version(f), comment: clearable(f, "comment"), reason: clearable(f, "reason") }), "Done");
}

export async function rejectTransferAction(id: string, _: ActionState, f: FormData): Promise<ActionState> {
  return runAction("transfers.reject", (tx, ctx) => rejectTransfer(tx, ctx, { id, version: version(f), comment: str(f, "comment") ?? "" }), "Sent back to draft");
}

// Rows ship.<i>.*; the Idempotency-Key is rendered into the form (double submit replays).
export async function shipAction(id: string, key: string, _: ActionState, f: FormData): Promise<ActionState> {
  return runAction("transfers.ship", (tx, ctx) => {
    const lines: ShipLineInput[] = [];
    for (let i = 0; f.has(`ship.${i}.lineId`); i++) {
      lines.push({ lineId: str(f, `ship.${i}.lineId`)!, qty: str(f, `ship.${i}.qty`) ?? "0", serials: list(f, `ship.${i}.serials`) });
    }
    return shipTransfer(tx, ctx, { id, version: version(f), lines });
  }, "Shipped", undefined, key);
}

export async function receiveTransferAction(id: string, key: string, _: ActionState, f: FormData): Promise<ActionState> {
  return runAction("transfers.receive", (tx, ctx) => {
    const lines: ReceiveLineInput[] = [];
    for (let i = 0; f.has(`rcv.${i}.lineId`); i++) {
      const p = `rcv.${i}.`;
      const qtys = { received: str(f, p + "received"), damaged: str(f, p + "damaged"), missing: str(f, p + "missing") };
      if (!Object.values(qtys).some((q) => q && Number(q) > 0)) continue;
      lines.push({ lineId: str(f, p + "lineId")!, ...qtys, binId: str(f, p + "binId"), serials: list(f, p + "serials"), damagedSerials: list(f, p + "damagedSerials") });
    }
    return receiveTransfer(tx, ctx, { id, version: version(f), note: clearable(f, "note"), lines });
  }, "Received", undefined, key);
}

export async function varianceAction(id: string, key: string, _: ActionState, f: FormData): Promise<ActionState> {
  return runAction("transfers.variance", (tx, ctx) => decideVariance(tx, ctx, {
    id, version: version(f), approve: f.get("decision") === "approve", comment: clearable(f, "comment"),
  }), "Decided", undefined, key);
}
