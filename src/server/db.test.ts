import { afterAll, expect, test } from "vitest";
import { db } from "./db";

afterAll(() => db.$disconnect());

test("connects to the test database", async () => {
  const [row] = await db.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
  expect(row.name).toBe("inventory_test");
});
