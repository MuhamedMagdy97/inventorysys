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
