import { z } from "zod";
import { idempotencyKey, parseBody, withApi, zId } from "@/server/core/api";
import { execute } from "@/server/core/execute";
import { requestCtx } from "@/server/auth/session-ctx";
import { cancelOrder } from "@/server/inventory/reservations";

const Body = z.object({ reason: z.string().max(200).optional() }); // e.g. "payment_failed"

// POST /api/sales-orders/:id/cancel — releases every open reservation of the order (SO-04, SO-07).
export const POST = withApi<{ id: string }>(async (req, { params, requestId }) => {
  const ctx = await requestCtx(req, requestId);
  const orderId = zId.parse(params.id);
  const key = idempotencyKey(req);
  const body = await parseBody(req, Body);
  return execute(
    ctx, { scope: "sales_orders.cancel", idempotencyKey: key, request: { orderId, ...body }, entity: { type: "sales_order_ref", id: orderId } },
    (tx) => cancelOrder(tx, ctx, { orderId, ...body }),
  );
});
