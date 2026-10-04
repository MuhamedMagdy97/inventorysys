import { z } from "zod";
import { idempotencyKey, parseBody, withApi, zId, zQty } from "@/server/core/api";
import { execute } from "@/server/core/execute";
import { requestCtx } from "@/server/auth/session-ctx";
import { reserve } from "@/server/inventory/reservations";

const Body = z.object({
  variantId: zId,
  warehouseId: zId,
  qty: zQty,
  batchId: zId.optional(),
  allowPartial: z.boolean().optional(),
  allowSubstitution: z.boolean().optional(),
  ttlSeconds: z.number().int().positive().optional(),
  orderRef: z.string().max(200).optional(),
});

// POST /api/reservations — atomic reserve (INV-002), idempotent (INV-017).
export const POST = withApi(async (req, { requestId }) => {
  const ctx = await requestCtx(req, requestId);
  const key = idempotencyKey(req);
  const body = await parseBody(req, Body);
  return execute(ctx, { scope: "reservations.create", idempotencyKey: key, request: body }, (tx) => reserve(tx, ctx, body));
});
