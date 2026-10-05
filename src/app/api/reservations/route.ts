import { z } from "zod";
import { idempotencyKey, parseBody, parseQuery, withApi, zId, zPage } from "@/server/core/api";
import { ReserveBody } from "../schemas";
import { execute } from "@/server/core/execute";
import { requestCtx } from "@/server/auth/session-ctx";
import { reserve } from "@/server/inventory/reservations";
import { listReservations } from "@/server/sales/orders";

// POST /api/reservations — atomic reserve (INV-002), idempotent (INV-017).
export const POST = withApi(async (req, { requestId }) => {
  const ctx = await requestCtx(req, requestId);
  const key = idempotencyKey(req);
  const body = await parseBody(req, ReserveBody);
  return execute(ctx, { scope: "reservations.create", idempotencyKey: key, request: body }, (tx) => reserve(tx, ctx, body));
});

const Query = z.object({
  q: z.string().max(100).optional(),
  status: z.enum(["active", "partially_fulfilled", "fulfilled", "cancelled", "expired"]).optional(),
  warehouseId: zId.optional(),
  ...zPage,
});

// GET /api/reservations?q&status&warehouseId&page&per_page
export const GET = withApi(async (req, { requestId }) => {
  const ctx = await requestCtx(req, requestId);
  const { per_page, ...q } = parseQuery(req, Query);
  return listReservations(ctx, { ...q, perPage: per_page });
});
