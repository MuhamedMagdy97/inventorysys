import { z } from "zod";
import { idempotencyKey, parseBody, withApi, zId, zQty } from "@/server/core/api";
import { AppError } from "@/server/core/errors";
import { execute } from "@/server/core/execute";
import { requestCtx } from "@/server/auth/session-ctx";
import { cancel, extend, fulfil, release } from "@/server/inventory/reservations";

const Body = z.object({
  version: z.number().int().min(0),
  qty: zQty.optional(), // fulfil/release: defaults to the whole open quantity
  reason: z.string().max(200).optional(),
  serials: z.array(z.string().max(100)).max(10000).optional(), // fulfil of serialized items: the units shipped (S-02)
});
const actions = { fulfil, release, cancel, extend } as const;

// POST /api/reservations/:id/{fulfil|release|cancel|extend} — version-checked (INV-023), idempotent (INV-017).
export const POST = withApi<{ id: string; action: string }>(async (req, { params, requestId }) => {
  const ctx = await requestCtx(req, requestId);
  if (!Object.hasOwn(actions, params.action)) throw new AppError("not_found", "Unknown reservation action");
  const action = actions[params.action as keyof typeof actions];
  const reservationId = zId.parse(params.id);
  const key = idempotencyKey(req);
  const body = await parseBody(req, Body);
  return execute(
    ctx,
    { scope: `reservations.${params.action}`, idempotencyKey: key, request: { reservationId, ...body }, entity: { type: "reservation", id: reservationId } },
    (tx) => action(tx, ctx, { reservationId, ...body }),
  );
});
