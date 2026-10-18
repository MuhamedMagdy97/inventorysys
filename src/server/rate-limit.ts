import { createHash } from "node:crypto";
import { db } from "@/server/db";
import type { PrismaClient } from "@/generated/prisma/client";

// Doc 26 rate limits: one row per key in Postgres, so every web replica shares the count.
// Fixed 60 s window starting at the key's first hit; one statement per limited request,
// times from the DB clock (no replica clock skew). SET expressions read the old row.
// The key is stored as a SHA-256: it carries API keys / session tokens, which never go to the DB in clear.
export async function hit(rawKey: string, limit: number, client: PrismaClient = db): Promise<{ ok: true } | { ok: false; retryAfter: number }> {
  const key = createHash("sha256").update(rawKey).digest("hex");
  const [row] = await client.$queryRaw<{ count: number; retry_after: number }[]>`
    INSERT INTO rate_limit_hit (key, count, reset_at) VALUES (${key}, 1, now() + interval '60 seconds')
    ON CONFLICT (key) DO UPDATE SET
      count    = CASE WHEN rate_limit_hit.reset_at <= now() THEN 1 ELSE rate_limit_hit.count + 1 END,
      reset_at = CASE WHEN rate_limit_hit.reset_at <= now() THEN now() + interval '60 seconds' ELSE rate_limit_hit.reset_at END
    RETURNING count, ceil(extract(epoch from reset_at - now()))::int AS retry_after`;
  return row.count <= limit ? { ok: true } : { ok: false, retryAfter: row.retry_after };
}

// Worker job: drop ended windows (index on reset_at keeps it cheap).
export async function purgeRateLimits() {
  const deleted = await db.$executeRaw`DELETE FROM rate_limit_hit WHERE reset_at <= now()`;
  return { deleted };
}
