import { afterAll, beforeAll, expect, test } from "vitest";
import { db, transaction, type Tx } from "@/server/db";
import { seedCompany } from "@/server/seed";
import {
  addSupplierAddress, addSupplierContact, archiveSupplierChild, createSupplier, getSupplier, setSupplierProduct, updateSupplier,
} from "./suppliers";

let w: Awaited<ReturnType<typeof seedCompany>>;
const tx = <T>(fn: (tx: Tx) => Promise<T>) => transaction(fn);

beforeAll(async () => { w = await seedCompany(`sup-${crypto.randomUUID()}`); });
afterAll(() => db.$disconnect());

test("flow 4: sequential codes, company currency by default, audited", async () => {
  const a = await tx((t) => createSupplier(t, w.ctx, { name: "Alpha Ltd" }));
  const b = await tx((t) => createSupplier(t, w.ctx, { name: "Beta Ltd", currency: "EUR", paymentTerms: "net60" }));
  expect([a.code, b.code]).toEqual(["SUP-0001", "SUP-0002"]);
  expect([a.currency, b.currency]).toEqual(["USD", "EUR"]);
  expect(await db.auditLog.count({ where: { entityId: a.id, action: "create" } })).toBe(1);
});

test("lifecycle: active ↔ inactive → archived (terminal); archived can't be edited", async () => {
  const s = await tx((t) => createSupplier(t, w.ctx, { name: "Gamma" }));
  await tx((t) => updateSupplier(t, w.ctx, { id: s.id, version: 0, status: "inactive" }));
  await tx((t) => updateSupplier(t, w.ctx, { id: s.id, version: 1, status: "active" }));
  await expect(tx((t) => updateSupplier(t, w.ctx, { id: s.id, version: 1, name: "Stale" }))).rejects.toMatchObject({ code: "version_conflict" });
  await tx((t) => updateSupplier(t, w.ctx, { id: s.id, version: 2, status: "archived" }));
  await expect(tx((t) => updateSupplier(t, w.ctx, { id: s.id, version: 3, status: "active" }))).rejects.toMatchObject({ code: "invalid_transition" });
  await expect(tx((t) => addSupplierContact(t, w.ctx, { supplierId: s.id, name: "X" }))).rejects.toMatchObject({ code: "archived_conflict" });
});

test("contacts (one primary), addresses, archive instead of delete; supplier products (one preferred)", async () => {
  const s = await tx((t) => createSupplier(t, w.ctx, { name: "Delta" }));
  const c1 = await tx((t) => addSupplierContact(t, w.ctx, { supplierId: s.id, name: "Ann", isPrimary: true }));
  await tx((t) => addSupplierContact(t, w.ctx, { supplierId: s.id, name: "Bob", email: "bob@x.io", isPrimary: true }));
  expect((await db.supplierContact.findUniqueOrThrow({ where: { id: c1.id } })).isPrimary).toBe(false);
  await tx((t) => addSupplierAddress(t, w.ctx, { supplierId: s.id, type: "billing", line1: "1 Road", city: "Dubai", country: "AE" }));
  await tx((t) => archiveSupplierChild(t, w.ctx, { supplierId: s.id, kind: "contact", id: c1.id }));
  const view = await getSupplier(w.ctx, s.id);
  expect(view.contacts.map((c) => c.name)).toEqual(["Bob"]);
  expect(view.addresses).toHaveLength(1);
  expect(await db.supplierContact.count({ where: { supplierId: s.id } })).toBe(2); // nothing deleted

  const other = await tx((t) => createSupplier(t, w.ctx, { name: "Epsilon" }));
  const v = w.variants[0].id;
  await tx((t) => setSupplierProduct(t, w.ctx, { supplierId: s.id, variantId: v, lastPrice: "4.5", isPreferred: true }));
  await tx((t) => setSupplierProduct(t, w.ctx, { supplierId: other.id, variantId: v, lastPrice: "4.2", isPreferred: true }));
  const links = await db.supplierProduct.findMany({ where: { variantId: v }, orderBy: { lastPrice: "asc" } });
  expect(links.map((l) => [l.lastPrice?.toString(), l.isPreferred])).toEqual([["4.2", true], ["4.5", false]]);
  await expect(tx((t) => setSupplierProduct(t, w.ctx, { supplierId: s.id, variantId: v, minOrderQty: 0 }))).rejects.toMatchObject({ code: "validation_error" });
});
