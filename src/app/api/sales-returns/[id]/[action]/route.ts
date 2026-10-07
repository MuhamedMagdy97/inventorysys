import { requestCtx } from "@/server/auth/session-ctx";
import { idempotencyKey, parseBody, withApi, zId } from "@/server/core/api";
import type { Ctx } from "@/server/core/ctx";
import { AppError } from "@/server/core/errors";
import { execute } from "@/server/core/execute";
import type { Tx } from "@/server/db";
import { approveSalesReturn, cancelSalesReturn, receiveSalesReturn, rejectSalesReturn } from "@/server/returns/sales-returns";
import { SalesReturnAction } from "../../../schemas";

type Body = ReturnType<typeof SalesReturnAction.parse> & { id: string };
const actions: Record<string, (tx: Tx, ctx: Ctx, b: Body) => Promise<unknown>> = {
  approve: (tx, ctx, b) => approveSalesReturn(tx, ctx, b),
  reject: (tx, ctx, b) => rejectSalesReturn(tx, ctx, { ...b, comment: b.comment ?? "" }),
  cancel: (tx, ctx, b) => cancelSalesReturn(tx, ctx, b),
  receive: (tx, ctx, b) => receiveSalesReturn(tx, ctx, b),
};

// POST /api/sales-returns/:id/{approve|reject|cancel|receive} — version-checked (INV-023);
// receive posts stock (to quarantine) and needs an Idempotency-Key. Inspection: /api/quarantine.
export const POST = withApi<{ id: string; action: string }>(async (req, { params, requestId }) => {
  const ctx = await requestCtx(req, requestId);
  if (!Object.hasOwn(actions, params.action)) throw new AppError("not_found", "Unknown sales return action");
  const id = zId.parse(params.id);
  const key = params.action === "receive" ? idempotencyKey(req) : req.headers.get("idempotency-key");
  const body = { ...(await parseBody(req, SalesReturnAction)), id };
  return execute(
    ctx,
    { scope: `sales_returns.${params.action}`, idempotencyKey: key, request: body, entity: { type: "sales_return", id } },
    (tx) => actions[params.action](tx, ctx, body),
  );
});
