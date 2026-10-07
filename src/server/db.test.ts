import { afterAll, expect, test } from "vitest";
import { db } from "./db";

afterAll(() => db.$disconnect());

test("connects to the test database", async () => {
  const [row] = await db.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
  expect(row.name).toMatch(/^inventory(_p\d+)?_test$/); // per-worktree test DBs (inventory_pN_test)
});
