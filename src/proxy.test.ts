import { NextRequest } from "next/server";
import { afterEach, expect, test } from "vitest";
import { proxy } from "./proxy";

const req = (path: string, init: { method?: string; headers?: Record<string, string> } = {}) =>
  new NextRequest(`http://app.test${path}`, { method: init.method ?? "POST", headers: { host: "app.test", ...init.headers } });

afterEach(() => { delete process.env.CORS_ORIGINS; });

test("T10.3: sign-in is limited per IP → 429 rate_limited with Retry-After", async () => {
  const signIn = (ip: string) => proxy(req("/api/auth/sign-in/email", { headers: { "x-forwarded-for": `9.9.9.9, ${ip}` } }));
  for (let i = 0; i < 10; i++) expect(signIn("1.1.1.1").status).toBe(200);
  const res = signIn("1.1.1.1");
  expect(res.status).toBe(429);
  expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
  expect(await res.json()).toMatchObject({ code: "rate_limited", details: { retryAfterSeconds: expect.any(Number) } });
  expect(signIn("2.2.2.2").status).toBe(200); // another client is unaffected
});

test("T10.3: reserve is limited per API key; GETs are not limited", async () => {
  const reserve = (key: string) => proxy(req("/api/reservations", { headers: { "x-api-key": key } }));
  for (let i = 0; i < 300; i++) expect(reserve("k1").status).toBe(200);
  expect(reserve("k1").status).toBe(429);
  expect(reserve("k2").status).toBe(200);
  expect(proxy(req("/api/reservations", { method: "GET", headers: { "x-api-key": "k1" } })).status).toBe(200);
});

test("T10.3: CORS allowlist + Origin check on state-changing requests", async () => {
  process.env.CORS_ORIGINS = "https://shop.example";
  const foreign = proxy(req("/api/products", { headers: { origin: "https://evil.example" } }));
  expect(foreign.status).toBe(403);
  expect(await foreign.json()).toMatchObject({ code: "forbidden", details: { reason: "cors" } });

  const allowed = proxy(req("/api/products", { headers: { origin: "https://shop.example" } }));
  expect(allowed.status).toBe(200);
  expect(allowed.headers.get("access-control-allow-origin")).toBe("https://shop.example");

  const preflight = proxy(req("/api/reservations", { method: "OPTIONS", headers: { origin: "https://shop.example" } }));
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get("access-control-allow-headers")).toContain("idempotency-key");
  expect(proxy(req("/api/reservations", { method: "OPTIONS", headers: { origin: "https://evil.example" } })).status).toBe(403);

  expect(proxy(req("/api/products", { headers: { origin: "http://app.test" } })).status).toBe(200); // same origin
  const read = proxy(req("/api/products", { method: "GET", headers: { origin: "https://evil.example" } }));
  expect([read.status, read.headers.get("access-control-allow-origin")]).toEqual([200, null]); // browser blocks the read
});
