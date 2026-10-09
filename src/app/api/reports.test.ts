import { afterAll, beforeAll, expect, test } from "vitest";
import { db, transaction } from "@/server/db";
import { notify } from "@/server/notifications/notify";
import { postMovements } from "@/server/inventory/post";
import { seedCompany } from "@/server/seed";
import { createWarehouse } from "@/server/warehouses/warehouses";
import { loginUser } from "@/test/auth";
import { GET as dashboard } from "./dashboard/route";
import { PUT as putPrefs, GET as getPrefs } from "./notifications/preferences/route";
import { POST as markRead } from "./notifications/read/route";
import { GET as notifications } from "./notifications/route";
import { GET as report } from "./reports/[name]/route";
import { GET as search } from "./search/route";

// Part 9 through HTTP: reports (JSON + audited CSV) under scope, dashboard, notification
// center + preferences, global search.
let w: Awaited<ReturnType<typeof seedCompany>>;
let B: string;
let owner: Record<string, string>, staffB: Record<string, string>;
const url = (p: string) => `http://localhost:3000/api/${p}`;
const send = (h: Record<string, string>, method: string, p: string, body?: unknown) =>
  new Request(url(p), { method, headers: { ...h, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const json = async (res: Response) => ({ status: res.status, body: await res.json() });
const rep = (h: Record<string, string>, name: string, qs = "") => report(send(h, "GET", `reports/${name}${qs}`), { params: Promise.resolve({ name }) });

beforeAll(async () => {
  w = await seedCompany(`api-rep-${crypto.randomUUID()}`);
  B = (await transaction((t) => createWarehouse(t, w.ctx, { code: "WH-B", name: "Branch" }))).id;
  const auditor = await loginUser(w, "auditor"); // all warehouses, reports.view + export
  owner = (await auditor.signIn()).headers;
  staffB = (await (await loginUser(w, "viewer", [B])).signIn()).headers; // reports.view only, B only
  await transaction((tx) => postMovements(tx, w.ctx, {
    sourceType: "opening", sourceId: "ob-1",
    legs: [{ type: "opening_balance", variantId: w.variants[0].id, warehouseId: w.warehouse.id, binId: w.warehouse.bins.find((b) => b.code === "MAIN")!.id, delta: { onHand: 5 }, unitCost: 2, line: 1, reasonCode: "opening" }],
  }));
  await transaction((tx) => notify(tx, w.ctx, { type: "transfer.shipped", entityType: "transfer", entityId: "t", warehouseId: B, message: "B news" }));
});
afterAll(() => db.$disconnect());

test("reports: JSON, CSV export (audited), scope, validation", async () => {
  const sum = await json(await rep(owner, "summary"));
  expect(sum.status).toBe(200);
  expect(sum.body.sections[0].rows).toEqual([expect.objectContaining({ sku: "TSHIRT-RED-M", on_hand: "5", value: "10" })]);

  const csv = await rep(owner, "valuation", "?groupBy=warehouse&format=csv");
  expect(csv.headers.get("content-type")).toContain("text/csv");
  expect(await csv.text()).toContain("WH-MAIN-01,5,2,10");
  expect(await db.auditLog.count({ where: { companyId: w.company.id, action: "export", entityId: "valuation" } })).toBe(1);

  expect((await json(await rep(staffB, "summary"))).body.sections[0].rows).toEqual([]);
  expect((await rep(staffB, "summary", `?warehouseId=${w.warehouse.id}`)).status).toBe(403);
  expect((await rep(staffB, "summary", "?format=csv")).status).toBe(403); // no reports.export
  expect((await rep(owner, "nope")).status).toBe(404);
  expect((await json(await rep(owner, "ledger", "?from=garbage"))).body.code).toBe("validation_error");
  expect((await json(await rep(owner, "ledger", "?to=2000-01-01"))).body.sections[0].rows).toEqual([]);
});

test("dashboard, notifications, preferences, search", async () => {
  const d = await json(await dashboard(send(owner, "GET", "dashboard")));
  expect(d.body.kpis.inventoryValue).toBe("10.00");
  expect((await json(await dashboard(send(staffB, "GET", "dashboard")))).body.kpis.inventoryValue).toBe("0.00");

  const n = await json(await notifications(send(staffB, "GET", "notifications?unread=1")));
  expect(n.body).toMatchObject({ unread: 1, items: [expect.objectContaining({ message: "B news", readAt: null })] });
  expect((await markRead(send(staffB, "POST", "notifications/read", {}))).status).toBe(200);
  expect((await json(await notifications(send(staffB, "GET", "notifications")))).body.unread).toBe(0);

  expect((await putPrefs(send(staffB, "PUT", "notifications/preferences", { emailCategories: ["stock"] }))).status).toBe(200);
  expect((await json(await getPrefs(send(staffB, "GET", "notifications/preferences")))).body).toEqual({ emailCategories: ["stock"] });
  expect((await putPrefs(send(staffB, "PUT", "notifications/preferences", { emailCategories: ["bogus"] }))).status).toBe(422);

  const s = await json(await search(send(owner, "GET", "search?q=TSHIRT")));
  expect(s.body.hits.filter((h: { group: string }) => h.group === "Products")).toHaveLength(2);
  expect((await search(send(owner, "GET", "search?q=a"))).status).toBe(422);
});
