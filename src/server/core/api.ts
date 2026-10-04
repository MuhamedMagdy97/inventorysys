import { z } from "zod";
import { AppError, ERROR_STATUS, fromDbError } from "./errors";

type Handler<P> = (req: Request, extra: { params: P; requestId: string }) => Promise<unknown>;

// Thin route wrapper: runs the handler, returns its result as JSON, maps errors
// to `{code, message, details, trace_id}` (doc 24).
export function withApi<P = Record<string, string>>(handler: Handler<P>) {
  return async (req: Request, routeCtx?: { params: Promise<P> }): Promise<Response> => {
    const requestId = req.headers.get("x-request-id") ?? crypto.randomUUID();
    try {
      const params = (await routeCtx?.params) ?? ({} as P);
      const result = await handler(req, { params, requestId });
      return result instanceof Response ? result : Response.json(result);
    } catch (err) {
      const e = toAppError(err);
      if (e.code === "conflict" && !(err instanceof AppError)) console.error(err);
      return Response.json(
        { code: e.code, message: e.message, details: e.details ?? null, trace_id: requestId },
        { status: ERROR_STATUS[e.code] },
      );
    }
  };
}

export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof z.ZodError) return new AppError("validation_error", "Invalid input", err.issues);
  const db = fromDbError(err);
  if (db) return db;
  // Unknown failure: don't leak internals. ponytail: no 500 code in the spec list; `conflict` + log.
  return new AppError("conflict", "Unexpected error");
}

export async function parseBody<T extends z.ZodType>(req: Request, schema: T): Promise<z.infer<T>> {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    throw new AppError("validation_error", "Body must be JSON");
  }
  return schema.parse(json);
}

export function parseQuery<T extends z.ZodType>(req: Request, schema: T): z.infer<T> {
  return schema.parse(Object.fromEntries(new URL(req.url).searchParams));
}

// Decimal(18,4) quantity as a string, strictly > 0. Never a float.
export const zQty = z
  .union([z.string(), z.number()])
  .transform(String)
  .refine((s) => /^\d{1,14}(\.\d{1,4})?$/.test(s) && Number(s) > 0, "Must be a positive number with ≤ 4 decimals");

export const zId = z.uuid();

export const zPage = {
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(200).default(50),
};

// INV-017: every stock-mutating POST carries a client Idempotency-Key.
export function idempotencyKey(req: Request): string {
  const key = req.headers.get("idempotency-key");
  if (!key || key.length > 200) throw new AppError("validation_error", "Idempotency-Key header is required (max 200 chars)");
  return key;
}
