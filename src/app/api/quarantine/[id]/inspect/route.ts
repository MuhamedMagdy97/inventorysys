import { requestCtx } from "@/server/auth/session-ctx";
import { idempotencyKey, parseBody, withApi, zId } from "@/server/core/api";
import { execute } from "@/server/core/execute";
import { inspectLot } from "@/server/inventory/inspection";
import { InspectBody } from "../../../schemas";

// POST /api/quarantine/:id/inspect — one inspection decision on a lot (restock / reject /
// dispose, with evidence ids from POST /api/evidence). Idempotency-Key required (INV-017).
export const POST = withApi<{ id: string }>(async (req, { params, requestId }) => {
  const ctx = await requestCtx(req, requestId);
  const lotId = zId.parse(params.id);
  const key = idempotencyKey(req);
  const body = await parseBody(req, InspectBody);
  return execute(ctx, { scope: "quarantine.inspect", idempotencyKey: key, request: { lotId, ...body }, entity: { type: "quarantine_lot", id: lotId } },
    (tx) => inspectLot(tx, ctx, { lotId, ...body }));
});
