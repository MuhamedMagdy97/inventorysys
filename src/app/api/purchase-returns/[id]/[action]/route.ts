import { requestCtx } from "@/server/auth/session-ctx";
import { idempotencyKey, parseBody, withApi, zId } from "@/server/core/api";
import type { Ctx } from "@/server/core/ctx";
import { AppError } from "@/server/core/errors";
import { execute } from "@/server/core/execute";
import type { Tx } from "@/server/db";
import {
  approvePurchaseReturn, cancelPurchaseReturn, closePurchaseReturn, confirmPurchaseReturn, rejectPurchaseReturn,
  shipPurchaseReturn, submitPurchaseReturn, supplierRejectPurchaseReturn,
} from "@/server/returns/purchase-returns";
import { PurchaseReturnAction } from "../../../schemas";

type Body = ReturnType<typeof PurchaseReturnAction.parse> & { id: string };
const actions: Record<string, (tx: Tx, ctx: Ctx, b: Body) => Promise<unknown>> = {
  submit: (tx, ctx, b) => submitPurchaseReturn(tx, ctx, b),
  approve: (tx, ctx, b) => approvePurchaseReturn(tx, ctx, b),
  reject: (tx, ctx, b) => rejectPurchaseReturn(tx, ctx, { ...b, comment: b.comment ?? "" }),
  cancel: (tx, ctx, b) => cancelPurchaseReturn(tx, ctx, b),
  ship: (tx, ctx, b) => shipPurchaseReturn(tx, ctx, b),
  confirm: (tx, ctx, b) => confirmPurchaseReturn(tx, ctx, b),
  "supplier-reject": (tx, ctx, b) => supplierRejectPurchaseReturn(tx, ctx, { ...b, note: b.note ?? "" }),
  close: (tx, ctx, b) => closePurchaseReturn(tx, ctx, b),
};
const POSTS_STOCK = new Set(["ship", "supplier-reject"]);

// POST /api/purchase-returns/:id/{submit|approve|reject|cancel|ship|confirm|supplier-reject|close}
// — version-checked (INV-023); ship / supplier-reject move stock and need an Idempotency-Key.
export const POST = withApi<{ id: string; action: string }>(async (req, { params, requestId }) => {
  const ctx = await requestCtx(req, requestId);
  if (!Object.hasOwn(actions, params.action)) throw new AppError("not_found", "Unknown purchase return action");
  const id = zId.parse(params.id);
  const key = POSTS_STOCK.has(params.action) ? idempotencyKey(req) : req.headers.get("idempotency-key");
  const body = { ...(await parseBody(req, PurchaseReturnAction)), id };
  return execute(
    ctx,
    { scope: `purchase_returns.${params.action}`, idempotencyKey: key, request: body, entity: { type: "purchase_return", id } },
    (tx) => actions[params.action](tx, ctx, body),
  );
});
