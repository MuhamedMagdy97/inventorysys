import { requestCtx } from "@/server/auth/session-ctx";
import { idempotencyKey, parseBody, withApi, zId } from "@/server/core/api";
import { execute } from "@/server/core/execute";
import { reverseReceipt } from "@/server/purchasing/receipts";
import { ReceiptReverse } from "../../../schemas";

// POST /api/receipts/:id/reverse — reversal receipt (RC-08, never a void).
export const POST = withApi<{ id: string }>(async (req, { params, requestId }) => {
  const ctx = await requestCtx(req, requestId);
  const receiptId = zId.parse(params.id);
  const key = idempotencyKey(req);
  const body = await parseBody(req, ReceiptReverse);
  return execute(ctx, { scope: "receipts.reverse", idempotencyKey: key, request: { receiptId, ...body }, entity: { type: "goods_receipt", id: receiptId } },
    (tx) => reverseReceipt(tx, ctx, { receiptId, ...body }));
});
