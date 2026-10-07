import { requestCtx } from "@/server/auth/session-ctx";
import { idempotencyKey, parseBody, withApi, zId } from "@/server/core/api";
import type { Ctx } from "@/server/core/ctx";
import { AppError } from "@/server/core/errors";
import { execute } from "@/server/core/execute";
import type { Tx } from "@/server/db";
import {
  applyAdjustment, approveAdjustment, cancelAdjustment, rejectAdjustment, submitAdjustment,
} from "@/server/inventory/adjustments";
import { AdjustmentAction } from "../../../schemas";

type Body = ReturnType<typeof AdjustmentAction.parse> & { id: string };
const actions: Record<string, (tx: Tx, ctx: Ctx, b: Body) => Promise<unknown>> = {
  submit: (tx, ctx, b) => submitAdjustment(tx, ctx, b),
  approve: (tx, ctx, b) => approveAdjustment(tx, ctx, b),
  reject: (tx, ctx, b) => rejectAdjustment(tx, ctx, { ...b, comment: b.comment ?? "" }),
  apply: (tx, ctx, b) => applyAdjustment(tx, ctx, b),
  cancel: (tx, ctx, b) => cancelAdjustment(tx, ctx, b),
};
// approve posts damage/repair/disposal; apply posts adjustments.
const POSTS_STOCK = new Set(["approve", "apply"]);

// POST /api/adjustments/:id/{submit|approve|reject|apply|cancel} — version-checked (INV-023).
export const POST = withApi<{ id: string; action: string }>(async (req, { params, requestId }) => {
  const ctx = await requestCtx(req, requestId);
  if (!Object.hasOwn(actions, params.action)) throw new AppError("not_found", "Unknown adjustment action");
  const id = zId.parse(params.id);
  const key = POSTS_STOCK.has(params.action) ? idempotencyKey(req) : req.headers.get("idempotency-key");
  const body = { ...(await parseBody(req, AdjustmentAction)), id };
  return execute(
    ctx,
    { scope: `adjustments.${params.action}`, idempotencyKey: key, request: body, entity: { type: "stock_adjustment", id } },
    (tx) => actions[params.action](tx, ctx, body),
  );
});
