import { afterAll, beforeAll, expect, test } from "vitest";
import { db, transaction } from "@/server/db";
import { postMovements } from "@/server/inventory/post";
import { reconcile } from "@/server/inventory/reconcile";
import { seedCompany } from "@/server/seed";
import { apiKeyHeaders, loginUser } from "@/test/auth";
import { GET as inbox } from "./approvals/route";
import { POST as countAction } from "./counts/[id]/[action]/route";
import { GET as getCount } from "./counts/[id]/route";
import { POST as postCount } from "./counts/route";
import { GET as exportStock } from "./exports/stock/route";
import { POST as importAction } from "./imports/[id]/[action]/route";
import { POST as postImport } from "./imports/route";

// Part 8 gate through HTTP: count open → scan entries → submit → approve from the inbox →
// apply; product import upload → preview → confirm; export is audited.
let w: Awaited<ReturnType<typeof seedCompany>>;
let mgrA: Record<string, string>, mgrB: Record<string, string>, staff: Record<string, string>, admin: Record<string, string>;
const url = (p: string) => `http://localhost:3000/api/${p}`;
const send = (h: Record<string, string>, method: string, p: string, body?: unknown) =>
  new Request(url(p), { method, headers: { ...h, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const params = <P>(p: P) => ({ params: Promise.resolve(p) });
const idem = (h: Record<string, string>) => ({ ...h, "idempotency-key": crypto.randomUUID() });
const json = async (res: Response) => ({ status: res.status, body: await res.json() });

beforeAll(async () => {
  w = await seedCompany(`api-cnt-${crypto.randomUUID()}`);
  [mgrA, mgrB, staff] = await Promise.all([
    loginUser(w, "inventory_manager").then((u) => u.signIn()).then((s) => s.headers),
    loginUser(w, "inventory_manager").then((u) => u.signIn()).then((s) => s.headers),
    loginUser(w, "warehouse_staff", [w.warehouse.id]).then((u) => u.signIn()).then((s) => s.headers),
  ]);
  admin = (await apiKeyHeaders(w, "admin")).headers;
  await transaction((tx) => postMovements(tx, w.ctx, {
    sourceType: "opening", sourceId: "ob-1",
    legs: [{ type: "opening_balance", variantId: w.variants[0].id, warehouseId: w.warehouse.id, binId: w.warehouse.bins.find((b) => b.code === "MAIN")!.id, delta: { onHand: 20 }, unitCost: 2, line: 1, reasonCode: "opening" }],
  }));
});
afterAll(() => db.$disconnect());

test("count: open → scan → submit → inbox approve → apply (idempotent)", async () => {
  const v = w.variants[0].id;
  const opened = await json(await postCount(send(mgrA, "POST", "counts", { warehouseId: w.warehouse.id, variantIds: [v] })));
  expect(opened.status).toBe(200);
  const id = opened.body.id as string;
  const act = (h: Record<string, string>, action: string, body: object) => countAction(send(h, "POST", `counts/${id}/${action}`, body), params({ id, action }));

  expect((await act(staff, "entries", { entries: [{ lineId: opened.body.lines[0].id, countedQty: "19" }] })).status).toBe(200); // −1 of 20 = 5% ≤ 10%
  expect((await json(await act(staff, "submit", {}))).body.code).toBe("validation_error"); // version required
  expect((await json(await act(staff, "submit", { version: 1 }))).body.status).toBe("variance_review");
  expect((await json(await act(mgrA, "approve", { version: 2 }))).body.code).toBe("forbidden"); // opened it

  const item = (await json(await inbox(send(mgrB, "GET", "approvals")))).body.items.find((i: { id: string }) => i.id === id);
  expect(item).toMatchObject({ type: "stock_count", amount: "2.00" });
  expect((await act(mgrB, "approve", { version: item.version })).status).toBe(200);
  expect((await json(await act(mgrB, "apply", { version: 3 }))).body.code).toBe("validation_error"); // Idempotency-Key required
  const h = idem(mgrB);
  const first = await json(await act(h, "apply", { version: 3 }));
  const again = await json(await act(h, "apply", { version: 3 })); // retry replays
  expect([first.status, first.body.status, again.body]).toEqual([200, "applied", first.body]);

  const c = (await json(await getCount(send(staff, "GET", `counts/${id}`), params({ id })))).body;
  expect(c.lines[0]).toMatchObject({ variance: "-1", qtyAtApply: "20" });
  expect(c.movements.map((m: { type: string }) => m.type)).toEqual(["adjustment_out"]);
  expect(await reconcile(w.ctx)).toEqual([]);
});

test("import: multipart upload → preview → confirm; export audited", async () => {
  const sku = `HTTP-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const form = new FormData();
  form.set("type", "products");
  form.set("file", new File([`sku,name,sell_price\n${sku},Via HTTP,9.5\n`], "products.csv", { type: "text/csv" }));
  const prev = await json(await postImport(new Request(url("imports"), { method: "POST", headers: admin, body: form })));
  expect([prev.status, prev.body.rowCount, prev.body.errorCount]).toEqual([200, 1, 0]);
  const id = prev.body.id as string;
  const conf = await json(await importAction(send(admin, "POST", `imports/${id}/confirm`, { version: 0 }), params({ id, action: "confirm" })));
  expect([conf.status, conf.body.status]).toEqual([200, "completed"]);
  expect(await db.productVariant.count({ where: { companyId: w.company.id, sku } })).toBe(1);
  const denied = await json(await postImport(new Request(url("imports"), { method: "POST", headers: staff, body: form })));
  expect(denied.body.code).toBe("forbidden");

  const res = await exportStock(send(mgrA, "GET", `exports/stock?warehouseId=${w.warehouse.id}`));
  expect([res.status, res.headers.get("content-type")]).toEqual([200, "text/csv; charset=utf-8"]);
  expect((await res.text()).split("\r\n")[0]).toBe("warehouse,bin,sku,name,batch_no,expiry_date,on_hand,blocked,damaged,expired");
  expect(await db.auditLog.count({ where: { companyId: w.company.id, action: "export" } })).toBe(1);
  expect((await json(await exportStock(send(staff, "GET", "exports/stock")))).body.code).toBe("forbidden"); // no reports.export
});
