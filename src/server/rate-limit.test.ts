import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, expect, test } from "vitest";
import { PrismaClient } from "@/generated/prisma/client";
import { db } from "@/server/db";
import { hit, purgeRateLimits } from "./rate-limit";

// A second client with its own pool = a second web replica.
const replica = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
afterAll(() => replica.$disconnect());

test("T12.1: two limiter instances share one count", async () => {
  const key = `t12.1|${crypto.randomUUID()}`;
  for (let i = 0; i < 3; i++) {
    expect(await hit(key, 6)).toEqual({ ok: true });
    expect(await hit(key, 6, replica)).toEqual({ ok: true });
  }
  const over = await hit(key, 6, replica);
  expect(over.ok).toBe(false);
  expect(over.ok === false && over.retryAfter).toBeGreaterThan(0);
  expect((await hit(key, 6)).ok).toBe(false);
});

test("T12.1: an ended window restarts the count and is purged", async () => {
  const key = `t12.1|${crypto.randomUUID()}`;
  await hit(key, 1);
  expect((await hit(key, 1)).ok).toBe(false);
  await db.rateLimitHit.update({ where: { key }, data: { resetAt: new Date(Date.now() - 1000) } });
  expect(await hit(key, 1)).toEqual({ ok: true }); // fresh window
  await db.rateLimitHit.update({ where: { key }, data: { resetAt: new Date(Date.now() - 1000) } });
  expect((await purgeRateLimits()).deleted).toBeGreaterThan(0);
  expect(await db.rateLimitHit.findUnique({ where: { key } })).toBeNull();
});
