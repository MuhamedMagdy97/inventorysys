import { crc32 } from "node:zlib";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { buildCtx } from "@/server/auth/session-ctx";
import { createProduct } from "@/server/catalog/catalog";
import type { Ctx } from "@/server/core/ctx";
import { db, transaction } from "@/server/db";
import { approveAdjustment } from "@/server/inventory/adjustments";
import { postMovements } from "@/server/inventory/post";
import { reconcile } from "@/server/inventory/reconcile";
import { createLoginUser, seedCompany } from "@/server/seed";
import { createWarehouse } from "@/server/warehouses/warehouses";
import { parseCsv, readTable, toCsv } from "./files";
import { confirmImport, exportStock, listImports, previewImport } from "./imports";

// Part 8 gate: import preview/confirm (all-or-nothing rollback, valid-only), opening
// balance import, scoped + audited export (flows 20, 21, 26; edge #14).

let w: Awaited<ReturnType<typeof seedCompany>>;
let mgr: Ctx;
const enc = (s: string) => new TextEncoder().encode(s);
const sku = () => `IMP-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

// A stored (uncompressed) zip, enough for an .xlsx fixture.
function zip(files: Record<string, string>) {
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text), n = Buffer.from(name), crc = crc32(data);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt32LE(crc, 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
    local.push(h, n, data); central.push(c, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}

beforeAll(async () => {
  w = await seedCompany(`imp-${crypto.randomUUID()}`);
  const roleId = w.roles.find((r) => r.code === "inventory_manager")!.id;
  const u = await transaction((t) => createLoginUser(t, w.company.id, { name: "mgr", email: `m+${crypto.randomUUID()}@test.invalid`, password: "x", roleId }));
  mgr = await buildCtx(u.id, { requestId: crypto.randomUUID(), channel: "system" });
});
afterAll(async () => {
  expect(await reconcile(w.ctx)).toEqual([]);
  await db.$disconnect();
});

describe("files", () => {
  test("CSV quoting/CRLF/BOM round-trip; xlsx shared + inline strings; formula guard", () => {
    expect(parseCsv('﻿a,b\r\n"x, ""y""",2\n')).toEqual([["a", "b"], ['x, "y"', "2"]]);
    expect(toCsv([["=1+2", "-5", 'a"b']])).toBe(`'=1+2,-5,"a""b"\r\n`);
    const xlsx = zip({
      "xl/sharedStrings.xml": '<sst><si><t>SKU</t></si><si><t>Name</t></si><si><r><t>Red </t></r><r><t>&amp; Blue</t></r></si></sst>',
      "xl/worksheets/sheet1.xml": '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="inlineStr"><is><t>Qty</t></is></c></row>'
        + '<row r="2"><c r="A2" t="inlineStr"><is><t>AB-1</t></is></c><c r="B2" t="s"><v>2</v></c><c r="D2"><v>3.5</v></c></row></sheetData></worksheet>',
    });
    expect(readTable("f.xlsx", xlsx)).toEqual({ header: ["sku", "name", "", "qty"], rows: [{ sku: "AB-1", name: "Red & Blue", "": "", qty: "3.5" }] });
    expect(() => readTable("f.txt", enc("a"))).toThrow(/csv or .xlsx/);
  });
});

describe("product import (flow 20, edge #14)", () => {
  test("preview flags duplicate / existing / invalid SKUs; all-or-nothing refuses; valid-only imports the rest", async () => {
    const [a, b, taken] = [sku(), sku(), w.variants[0].sku];
    const csv = `sku,name,cost_price\n${a},Alpha,5\n${a},Alpha again,5\n${taken},Dupe of DB,1\nbad sku!,Broken,1\n${b},Beta,abc\n`;
    const job = await previewImport(w.ctx, { type: "products", fileName: "p.csv", bytes: enc(csv) });
    expect([job.status, job.rowCount, job.errorCount]).toEqual(["previewed", 5, 4]);
    expect((job.errors as { row: number }[]).map((e) => e.row)).toEqual([3, 4, 5, 6]);
    await expect(confirmImport(w.ctx, { id: job.id, version: 0 })).rejects.toMatchObject({ code: "validation_error", details: { field: "mode" } });
    const done = await confirmImport(w.ctx, { id: job.id, version: 0, mode: "valid_only" });
    expect([done.status, done.mode, (done.result as { imported: number }).imported]).toEqual(["completed", "valid_only", 1]);
    expect(await db.productVariant.count({ where: { companyId: w.company.id, sku: { in: [a, b] } } })).toBe(1);
    await expect(confirmImport(w.ctx, { id: job.id, version: 1 })).rejects.toMatchObject({ code: "invalid_transition" });
  });

  test("rollback: a row that fails at confirm undoes every row; the failed attempt stays in history", async () => {
    const [a, b] = [sku(), sku()];
    const job = await previewImport(w.ctx, { type: "products", fileName: "p.csv", bytes: enc(`sku,name\n${a},One\n${b},Two\n`) });
    expect(job.errorCount).toBe(0);
    await transaction((t) => createProduct(t, w.ctx, { name: "Sneaked in", variants: [{ sku: b }] })); // between preview and confirm
    await expect(confirmImport(w.ctx, { id: job.id, version: 0 })).rejects.toMatchObject({ code: "duplicate", details: { row: 3 } });
    expect(await db.productVariant.count({ where: { companyId: w.company.id, sku: a } })).toBe(0);
    const after = await db.importJob.findUniqueOrThrow({ where: { id: job.id } });
    expect([after.status, after.mode, after.errorCount]).toEqual(["failed", "all_or_nothing", 1]);
    expect(await db.auditLog.count({ where: { entityId: job.id, action: { in: ["import.preview", "import.failed"] } } })).toBe(2);
    expect((await listImports(w.ctx, { page: 1, perPage: 50 })).items.map((i) => i.id)).toContain(job.id);
  });
});

describe("opening balance import (flow 26) + export (flow 21)", () => {
  test("rows → one submitted opening document; a second user approves; stock posts as of the date", async () => {
    const asOf = new Date(Date.now() - 7 * 86_400_000);
    const v = w.variants[1];
    const job = await previewImport(w.ctx, {
      type: "opening_balance", fileName: "ob.csv", warehouseId: w.warehouse.id, asOf,
      bytes: enc(`sku,qty,unit_cost,bin\n${v.sku},6,3,RECV\nNOPE-1,1,1,\n${v.sku},-1,3,\n`),
    });
    expect((job.errors as { row: number }[]).map((e) => e.row)).toEqual([3, 4]);
    const done = await confirmImport(w.ctx, { id: job.id, version: 0, mode: "valid_only" });
    const { adjustmentId, status } = done.result as { adjustmentId: string; status: string };
    expect(status).toBe("submitted");
    await transaction((t) => approveAdjustment(t, mgr, { id: adjustmentId, version: 1 }));
    const m = await db.inventoryMovement.findFirstOrThrow({ where: { sourceId: adjustmentId } });
    expect([m.type, m.dOnHand.toString(), m.createdAt.toISOString()]).toEqual(["opening_balance", "6", asOf.toISOString()]);
  });

  test("export: CSV limited to the caller's warehouses, one audit row per export", async () => {
    const B = await transaction((t) => createWarehouse(t, w.ctx, { code: "WH-EXP", name: "Export test" }));
    await transaction((t) => postMovements(t, w.ctx, {
      sourceType: "test", sourceId: "exp-1",
      legs: [{ type: "adjustment_in", variantId: w.variants[0].id, warehouseId: B.id, binId: B.bins.find((b) => b.code === "MAIN")!.id, delta: { onHand: 2 }, unitCost: 1, line: 1, reasonCode: "test" }],
    }));
    const roleId = w.roles.find((r) => r.code === "accountant")!.id;
    const u = await transaction((t) => createLoginUser(t, w.company.id, { name: "acc", email: `a+${crypto.randomUUID()}@test.invalid`, password: "x", roleId, warehouseIds: [B.id] }));
    const acc = await buildCtx(u.id, { requestId: crypto.randomUUID(), channel: "system" });
    const out = await exportStock(acc);
    expect(out.rowCount).toBe(1);
    const [head, row, end] = out.csv.split("\r\n");
    expect([head, end]).toEqual(["warehouse,bin,sku,name,batch_no,expiry_date,on_hand,blocked,damaged,expired", ""]);
    expect(row).toMatch(new RegExp(`^WH-EXP,MAIN,${w.variants[0].sku},.*,,,2,0,0,0$`));
    await expect(exportStock(acc, { warehouseId: w.warehouse.id })).rejects.toMatchObject({ code: "forbidden" });
    const audit = await db.auditLog.findMany({ where: { companyId: w.company.id, action: "export", actorId: u.id } });
    expect(audit).toHaveLength(1);
    expect(audit[0].after).toMatchObject({ rowCount: 1, format: "csv" });
    await expect(exportStock(mgr, {})).resolves.toMatchObject({ rowCount: expect.any(Number) }); // all warehouses
  });
});
