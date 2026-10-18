import { requestCtx } from "@/server/auth/session-ctx";
import { idempotencyKey, parseBody, withApi, zId } from "@/server/core/api";
import { execute } from "@/server/core/execute";
import { createLandedCost, listLandedCosts } from "@/server/purchasing/landed-cost";
import { LandedCostCreate } from "../../../schemas";

// GET /api/receipts/:id/landed-costs — landed-cost documents of a receipt (doc 15 §1.1).
export const GET = withApi<{ id: string }>(async (req, { params, requestId }) =>
  listLandedCosts(await requestCtx(req, requestId), { receiptId: zId.parse(params.id) }));

// POST /api/receipts/:id/landed-costs — allocate charges to the receipt's lines; waits for approval.
export const POST = withApi<{ id: string }>(async (req, { params, requestId }) => {
  const ctx = await requestCtx(req, requestId);
  const receiptId = zId.parse(params.id);
  const key = idempotencyKey(req);
  const body = await parseBody(req, LandedCostCreate);
  return execute(ctx, { scope: "landed_costs.create", idempotencyKey: key, request: { receiptId, ...body }, entity: { type: "goods_receipt", id: receiptId } },
    (tx) => createLandedCost(tx, ctx, { receiptId, ...body }));
});
