import { afterAll, expect, test } from "vitest";
import { db } from "./db";
import { seedCompany } from "./seed";

afterAll(() => db.$disconnect());

test("seed creates 1 company, 1 warehouse with default bins, 2 variants", async () => {
  const { company } = await seedCompany(`seed-${crypto.randomUUID()}`);
  const warehouses = await db.warehouse.findMany({ where: { companyId: company.id }, include: { bins: true } });
  expect(warehouses).toHaveLength(1);
  expect(warehouses[0].bins.map((b) => b.type).sort()).toEqual(["damaged", "quarantine", "receiving", "sellable"]);
  expect(warehouses[0].bins.filter((b) => b.isDefaultSellable)).toHaveLength(1);
  expect(await db.productVariant.count({ where: { companyId: company.id } })).toBe(2);
  expect(await db.auditLog.count({ where: { companyId: company.id } })).toBe(2);
});
