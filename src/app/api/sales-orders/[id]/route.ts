import { withApi, zId } from "@/server/core/api";
import { requestCtx } from "@/server/auth/session-ctx";
import { getSalesOrder } from "@/server/sales/orders";

// GET /api/sales-orders/:id — the order ref, derived status and its reservations.
export const GET = withApi<{ id: string }>(async (req, { params, requestId }) =>
  getSalesOrder(await requestCtx(req, requestId), zId.parse(params.id)));
