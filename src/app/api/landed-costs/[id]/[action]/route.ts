import { requestCtx } from "@/server/auth/session-ctx";
import { idempotencyKey, parseBody, withApi, zId } from "@/server/core/api";
import { AppError } from "@/server/core/errors";
import { execute } from "@/server/core/execute";
import { approveLandedCost, rejectLandedCost } from "@/server/purchasing/landed-cost";
import { LandedCostDecision } from "../../../schemas";

// POST /api/landed-costs/:id/{approve|reject} — approve posts cost_correction movements (doc 15 §1.1).
export const POST = withApi<{ id: string; action: string }>(async (req, { params, requestId }) => {
  const ctx = await requestCtx(req, requestId);
  if (params.action !== "approve" && params.action !== "reject") throw new AppError("not_found", "Unknown landed-cost action");
  const id = zId.parse(params.id);
  const key = params.action === "approve" ? idempotencyKey(req) : req.headers.get("idempotency-key");
  const body = { ...(await parseBody(req, LandedCostDecision)), id };
  return execute(ctx, { scope: `landed_costs.${params.action}`, idempotencyKey: key, request: body, entity: { type: "landed_cost", id } },
    (tx) => params.action === "approve" ? approveLandedCost(tx, ctx, body) : rejectLandedCost(tx, ctx, { ...body, comment: body.comment ?? "" }));
});
