import { requestCtx } from "@/server/auth/session-ctx";
import { idempotencyKey, parseBody, withApi, zId } from "@/server/core/api";
import type { Ctx } from "@/server/core/ctx";
import { AppError } from "@/server/core/errors";
import { execute } from "@/server/core/execute";
import type { Tx } from "@/server/db";
import { applyCount, approveCount, cancelCount, enterCounts, recountCount, submitCount } from "@/server/inventory/counts";
import { CountAction } from "../../../schemas";

type Body = ReturnType<typeof CountAction.parse> & { id: string };
const v = (b: Body) => {
  if (b.version === undefined) throw new AppError("validation_error", "version is required", { field: "version" });
  return b.version;
};
const actions: Record<string, (tx: Tx, ctx: Ctx, b: Body) => Promise<unknown>> = {
  entries: (tx, ctx, b) => enterCounts(tx, ctx, { id: b.id, entries: b.entries ?? [] }),
  submit: (tx, ctx, b) => submitCount(tx, ctx, { id: b.id, version: v(b) }),
  recount: (tx, ctx, b) => recountCount(tx, ctx, { id: b.id, version: v(b), lineIds: b.lineIds ?? [] }),
  approve: (tx, ctx, b) => approveCount(tx, ctx, { id: b.id, version: v(b), comment: b.comment }),
  apply: (tx, ctx, b) => applyCount(tx, ctx, { id: b.id, version: v(b) }),
  cancel: (tx, ctx, b) => cancelCount(tx, ctx, { id: b.id, version: v(b) }),
};

// POST /api/counts/:id/{entries|submit|recount|approve|apply|cancel}. apply posts stock.
export const POST = withApi<{ id: string; action: string }>(async (req, { params, requestId }) => {
  const ctx = await requestCtx(req, requestId);
  if (!Object.hasOwn(actions, params.action)) throw new AppError("not_found", "Unknown count action");
  const id = zId.parse(params.id);
  const key = params.action === "apply" ? idempotencyKey(req) : req.headers.get("idempotency-key");
  const body = { ...(await parseBody(req, CountAction)), id };
  return execute(
    ctx,
    { scope: `counts.${params.action}`, idempotencyKey: key, request: body, entity: { type: "stock_count", id } },
    (tx) => actions[params.action](tx, ctx, body),
  );
});
