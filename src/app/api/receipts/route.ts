import { requestCtx } from "@/server/auth/session-ctx";
import { idempotencyKey, parseBody, withApi } from "@/server/core/api";
import { execute } from "@/server/core/execute";
import { postReceipt } from "@/server/purchasing/receipts";
import { ReceiptCreate } from "../schemas";

// POST /api/receipts — post a GRN (flow 6/7). Idempotency-Key required (RC-01, INV-017).
export const POST = withApi(async (req, { requestId }) => {
  const ctx = await requestCtx(req, requestId);
  const key = idempotencyKey(req);
  const body = await parseBody(req, ReceiptCreate);
  return execute(ctx, { scope: "receipts.create", idempotencyKey: key, request: body, entity: { type: "purchase_order", id: body.poId } },
    (tx) => postReceipt(tx, ctx, body, key));
});
