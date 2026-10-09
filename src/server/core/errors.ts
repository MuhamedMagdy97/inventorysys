// Spec error codes (doc 24) — the only codes the API may return.
export const ERROR_STATUS = {
  insufficient_stock: 409,
  reserved_conflict: 409,
  batch_insufficient: 409,
  invalid_transition: 422,
  version_conflict: 409,
  archived_conflict: 409,
  discontinued_conflict: 409,
  reservation_expired: 409,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  validation_error: 422,
  duplicate: 409,
  rate_limited: 429, // doc 26 rate limits (src/proxy.ts)
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string = code,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }

  get status(): number {
    return ERROR_STATUS[this.code];
  }
}

// INV-023 optimistic lock: an `updateMany({ where: { id, version } })` that matched nothing.
export function assertVersion(res: { count: number }, entity: string, currentVersion?: number) {
  if (res.count === 0) throw new AppError("version_conflict", `${entity} was changed by someone else`, { currentVersion });
}

// DB constraints are the last line of defence (tech-stack rule 2); surface their
// violations as spec codes instead of a generic failure.
export function fromDbError(e: unknown): AppError | null {
  const err = e as { code?: string; meta?: { driverAdapterError?: { cause?: { originalCode?: string; originalMessage?: string; constraint?: { index?: string } } } } };
  const cause = err?.meta?.driverAdapterError?.cause;
  const pg = cause?.originalCode;
  if (err?.code === "P2002" || pg === "23505") {
    const constraint = cause?.constraint?.index ?? cause?.originalMessage?.match(/"([^"]+)"/)?.[1];
    return new AppError("duplicate", "Already exists", { field: constraint?.match(/_([a-z]+)_key$/)?.[1], constraint });
  }
  if (err?.code === "P2025") return new AppError("not_found", "Not found"); // findUniqueOrThrow & co.
  if (pg === "23514" || pg === "23503") {
    return new AppError("validation_error", "Rejected by a database rule", { constraint: cause?.originalMessage?.match(/constraint "([^"]+)"/)?.[1] });
  }
  return null;
}
