import { idempotencyKey, parseBody, withApi } from "@/server/core/api";
import { execute } from "@/server/core/execute";
import { requestCtx } from "@/server/auth/session-ctx";
import { posSale } from "@/server/inventory/reservations";
import { ReserveBody } from "../schemas";

const Body = ReserveBody.omit({ allowPartial: true, ttlSeconds: true });

// POST /api/pos-sales — immediate sale: reserve + fulfil in one transaction (SO-02, SO-09).
export const POST = withApi(async (req, { requestId }) => {
  const ctx = await requestCtx(req, requestId);
  const key = idempotencyKey(req);
  const body = await parseBody(req, Body);
  return execute(ctx, { scope: "pos_sales.create", idempotencyKey: key, request: body }, (tx) => posSale(tx, ctx, body));
});
