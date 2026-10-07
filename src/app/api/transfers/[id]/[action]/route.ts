import { requestCtx } from "@/server/auth/session-ctx";
import { idempotencyKey, parseBody, withApi, zId } from "@/server/core/api";
import type { Ctx } from "@/server/core/ctx";
import { AppError } from "@/server/core/errors";
import { execute } from "@/server/core/execute";
import type { Tx } from "@/server/db";
import {
  approveTransfer, cancelTransfer, decideVariance, receiveTransfer, rejectTransfer, shipTransfer, submitTransfer,
} from "@/server/inventory/transfers";
import { TransferAction } from "../../../schemas";

type Body = ReturnType<typeof TransferAction.parse> & { id: string };
const actions: Record<string, (tx: Tx, ctx: Ctx, b: Body) => Promise<unknown>> = {
  submit: (tx, ctx, b) => submitTransfer(tx, ctx, b),
  approve: (tx, ctx, b) => approveTransfer(tx, ctx, b),
  reject: (tx, ctx, b) => rejectTransfer(tx, ctx, { ...b, comment: b.comment ?? "" }),
  cancel: (tx, ctx, b) => cancelTransfer(tx, ctx, b),
  ship: (tx, ctx, b) => shipTransfer(tx, ctx, b),
  receive: (tx, ctx, b) => receiveTransfer(tx, ctx, { ...b, lines: b.lines ?? [] }),
  variance: (tx, ctx, b) => {
    if (b.approve === undefined) throw new AppError("validation_error", "approve is required", { field: "approve" });
    return decideVariance(tx, ctx, { ...b, approve: b.approve });
  },
};
const POSTS_STOCK = new Set(["ship", "receive", "variance"]);

// POST /api/transfers/:id/{submit|approve|reject|cancel|ship|receive|variance} — version-checked
// (INV-023); ship/receive/variance move stock and need an Idempotency-Key (INV-017, TR-03).
export const POST = withApi<{ id: string; action: string }>(async (req, { params, requestId }) => {
  const ctx = await requestCtx(req, requestId);
  if (!Object.hasOwn(actions, params.action)) throw new AppError("not_found", "Unknown transfer action");
  const id = zId.parse(params.id);
  const key = POSTS_STOCK.has(params.action) ? idempotencyKey(req) : req.headers.get("idempotency-key");
  const body = { ...(await parseBody(req, TransferAction)), id };
  return execute(
    ctx,
    { scope: `transfers.${params.action}`, idempotencyKey: key, request: body, entity: { type: "transfer", id } },
    (tx) => actions[params.action](tx, ctx, body),
  );
});
