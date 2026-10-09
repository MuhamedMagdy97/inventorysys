import { expect, test } from "vitest";
import { z } from "zod";
import { withApi } from "./api";
import { AppError, ERROR_STATUS, type ErrorCode } from "./errors";

const expected: Record<ErrorCode, number> = {
  insufficient_stock: 409, reserved_conflict: 409, batch_insufficient: 409,
  invalid_transition: 422, version_conflict: 409, archived_conflict: 409,
  discontinued_conflict: 409, reservation_expired: 409, forbidden: 403,
  not_found: 404, conflict: 409, validation_error: 422, duplicate: 409, rate_limited: 429,
};

test("every spec code maps to its HTTP status through withApi", async () => {
  expect(Object.keys(ERROR_STATUS).sort()).toEqual(Object.keys(expected).sort());
  for (const [code, status] of Object.entries(expected) as [ErrorCode, number][]) {
    const route = withApi(async () => { throw new AppError(code, "x", { a: 1 }); });
    const res = await route(new Request("http://t/", { headers: { "x-request-id": "r1" } }));
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ code, message: "x", details: { a: 1 }, trace_id: "r1" });
  }
});

test("zod errors become validation_error, unknown errors don't leak", async () => {
  const zodRoute = withApi(async () => z.object({ a: z.string() }).parse({}));
  expect((await zodRoute(new Request("http://t/"))).status).toBe(422);
  const boom = withApi(async () => { throw new Error("secret db detail"); });
  const body = await (await boom(new Request("http://t/"))).json();
  expect(body.message).not.toContain("secret");
});
