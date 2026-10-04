import { requestCtx } from "@/server/auth/session-ctx";
import { idempotencyKey, parseBody, withApi, zId } from "@/server/core/api";
import { execute } from "@/server/core/execute";
import { decideExcess } from "@/server/purchasing/receipts";
import { ExcessDecision } from "../../../schemas";

// POST /api/receipt-lines/:id/excess — approve (blocked_release + PO amended) or reject an over-delivery.
export const POST = withApi<{ id: string }>(async (req, { params, requestId }) => {
  const ctx = await requestCtx(req, requestId);
  const receiptLineId = zId.parse(params.id);
  const key = idempotencyKey(req);
  const body = await parseBody(req, ExcessDecision);
  return execute(ctx, { scope: "receipts.excess", idempotencyKey: key, request: { receiptLineId, ...body }, entity: { type: "receipt_line", id: receiptLineId } },
    (tx) => decideExcess(tx, ctx, { receiptLineId, ...body }));
});
