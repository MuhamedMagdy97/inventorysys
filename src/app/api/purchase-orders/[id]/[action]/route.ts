import { requestCtx } from "@/server/auth/session-ctx";
import { parseBody, withApi, zId } from "@/server/core/api";
import type { Ctx } from "@/server/core/ctx";
import { AppError } from "@/server/core/errors";
import { execute } from "@/server/core/execute";
import type { Tx } from "@/server/db";
import { approvePo, cancelPo, closePo, orderPo, reducePoLine, rejectPo, submitPo } from "@/server/purchasing/purchase-orders";
import { PoAction } from "../../../schemas";

type Body = ReturnType<typeof PoAction.parse> & { id: string };
const need = <T>(v: T | undefined, field: string): T => {
  if (v === undefined) throw new AppError("validation_error", `${field} is required`, { field });
  return v;
};
const actions: Record<string, (tx: Tx, ctx: Ctx, b: Body) => Promise<unknown>> = {
  submit: (tx, ctx, b) => submitPo(tx, ctx, b),
  approve: (tx, ctx, b) => approvePo(tx, ctx, b),
  reject: (tx, ctx, b) => rejectPo(tx, ctx, { ...b, comment: b.comment ?? "" }),
  order: (tx, ctx, b) => orderPo(tx, ctx, b),
  close: (tx, ctx, b) => closePo(tx, ctx, b),
  cancel: (tx, ctx, b) => cancelPo(tx, ctx, b),
  "reduce-line": (tx, ctx, b) => reducePoLine(tx, ctx, { poId: b.id, version: b.version, lineId: need(b.lineId, "lineId"), qty: need(b.qty, "qty") }),
};

// POST /api/purchase-orders/:id/{submit|approve|reject|order|close|cancel|reduce-line} — version-checked (INV-023).
export const POST = withApi<{ id: string; action: string }>(async (req, { params, requestId }) => {
  const ctx = await requestCtx(req, requestId);
  if (!Object.hasOwn(actions, params.action)) throw new AppError("not_found", "Unknown purchase order action");
  const id = zId.parse(params.id);
  const body = { ...(await parseBody(req, PoAction)), id };
  return execute(
    ctx,
    { scope: `purchase_orders.${params.action}`, idempotencyKey: req.headers.get("idempotency-key"), request: body, entity: { type: "purchase_order", id } },
    (tx) => actions[params.action](tx, ctx, body),
  );
});
