import { NextResponse, type NextRequest } from "next/server";

// Doc 26 request guards for /api, in one place so route handlers stay untouched:
// rate limits (sign-in, reserve, lookup), CORS allowlist, and an Origin check on
// state-changing requests (CSRF defence in depth on top of SameSite cookies).
// Static security headers live in next.config.ts.

const WINDOW_MS = 60_000;
type Rule = { match: (path: string) => boolean; limit: number; by: "ip" | "client" };
export const RULES: Rule[] = [
  // Sign-in + TOTP verify: per IP. Per-account brute force is also stopped by the 5-fail lockout.
  { match: (p) => p.startsWith("/api/auth/sign-in/") || p.startsWith("/api/auth/two-factor/"), limit: 10, by: "ip" },
  { match: (p) => p === "/api/reservations" || p === "/api/pos-sales", limit: 300, by: "client" },
  { match: (p) => p === "/api/products/lookup", limit: 600, by: "client" }, // scan bursts
];

// ponytail: fixed-window counters in process memory — per instance, reset on restart.
// Fine for one web container; with several replicas move the counter to Postgres/Redis.
const hits = new Map<string, { count: number; resetAt: number }>();

export function hit(key: string, limit: number, now = Date.now()): { ok: true } | { ok: false; retryAfter: number } {
  if (hits.size > 50_000) for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  let h = hits.get(key);
  if (!h || h.resetAt <= now) hits.set(key, (h = { count: 0, resetAt: now + WINDOW_MS }));
  h.count++;
  return h.count <= limit ? { ok: true } : { ok: false, retryAfter: Math.ceil((h.resetAt - now) / 1000) };
}

// ponytail: the last X-Forwarded-For hop is the address our own reverse proxy saw; with no
// proxy in front, the header is client-controlled. Deploy behind exactly one proxy (doc 02-deploy).
function ip(req: NextRequest) {
  const xff = req.headers.get("x-forwarded-for");
  return xff?.split(",").at(-1)?.trim() || req.headers.get("x-real-ip") || "local";
}

function client(req: NextRequest) {
  const key = req.headers.get("x-api-key");
  if (key) return `key:${key}`;
  const session = req.cookies.getAll().find((c) => c.name.endsWith("session_token"));
  return session ? `session:${session.value}` : `ip:${ip(req)}`;
}

const allowlist = () =>
  (process.env.CORS_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean);

function sameOrigin(req: NextRequest, origin: string) {
  try {
    const host = new URL(origin).host;
    const own = process.env.BETTER_AUTH_URL ? new URL(process.env.BETTER_AUTH_URL).host : null;
    return host === req.headers.get("host") || host === own;
  } catch {
    return false;
  }
}

const error = (req: NextRequest, status: number, code: string, message: string, details: unknown = null, headers?: HeadersInit) =>
  NextResponse.json({ code, message, details, trace_id: req.headers.get("x-request-id") ?? crypto.randomUUID() }, { status, headers });

const CORS_HEADERS = {
  "Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, idempotency-key, x-api-key, x-request-id",
  "Access-Control-Max-Age": "600",
};

export function proxy(req: NextRequest) {
  const path = req.nextUrl.pathname;  const origin = req.headers.get("origin");
  const crossAllowed = !!origin && !sameOrigin(req, origin) && allowlist().includes(origin);
  const cors: Record<string, string> = crossAllowed ? { "Access-Control-Allow-Origin": origin!, Vary: "Origin" } : {};

  if (req.method === "OPTIONS") {
    return crossAllowed ? new NextResponse(null, { status: 204, headers: { ...cors, ...CORS_HEADERS } }) : error(req, 403, "forbidden", "Origin not allowed", { reason: "cors" });
  }
  const mutating = !["GET", "HEAD"].includes(req.method);
  if (mutating && origin && !sameOrigin(req, origin) && !crossAllowed) {
    return error(req, 403, "forbidden", "Origin not allowed", { reason: "cors" });
  }
  if (mutating) {
    const rule = RULES.find((r) => r.match(path));
    if (rule) {
      const res = hit(`${path}|${rule.by === "ip" ? `ip:${ip(req)}` : client(req)}`, rule.limit);
      if (!res.ok) {
        return error(req, 429, "rate_limited", "Too many requests", { retryAfterSeconds: res.retryAfter },
          { ...cors, "Retry-After": String(res.retryAfter) });
      }
    }
  }
  const next = NextResponse.next();
  for (const [k, v] of Object.entries(cors)) next.headers.set(k, v);
  return next;
}

export const config = { matcher: "/api/:path*" };
