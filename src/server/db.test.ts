import { afterAll, expect, test } from "vitest";
import { db } from "./db";

afterAll(() => db.$disconnect());

test("connects to the test database", async () => {
  const [row] = await db.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
  expect(row.name).toMatch(/_test$/); // inventory_test, or a per-worktree *_test DB
});
