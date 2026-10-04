import type { z } from "zod";
import { requestCtx } from "@/server/auth/session-ctx";
import { parseBody } from "@/server/core/api";
import type { Ctx } from "@/server/core/ctx";
import { execute } from "@/server/core/execute";
import type { Tx } from "@/server/db";

// One master-data mutation: ctx → Zod body → domain fn in a transaction. An optional
// Idempotency-Key makes client retries safe (required only on stock-mutating routes).
export async function mutate<S extends z.ZodType>(
  req: Request,
  requestId: string,
  scope: string,
  schema: S,
  fn: (tx: Tx, ctx: Ctx, body: z.infer<S>) => Promise<unknown>,
) {
  const ctx = await requestCtx(req, requestId);
  const body = await parseBody(req, schema);
  return execute(ctx, { scope, idempotencyKey: req.headers.get("idempotency-key"), request: body }, (tx) => fn(tx, ctx, body));
}
