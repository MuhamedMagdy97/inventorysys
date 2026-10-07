import { afterAll, beforeAll, expect, test } from "vitest";
import { db, transaction } from "@/server/db";
import { postMovements } from "@/server/inventory/post";
import { reconcile } from "@/server/inventory/reconcile";
import { fulfil, reserve } from "@/server/inventory/reservations";
import { seedCompany } from "@/server/seed";
import { loginUser } from "@/test/auth";
import { GET as getEvidence } from "./evidence/[id]/route";
import { POST as upload } from "./evidence/route";
import { POST as inspect } from "./quarantine/[id]/inspect/route";
import { GET as quarantine } from "./quarantine/route";
import { POST as srAction } from "./sales-returns/[id]/[action]/route";
import { GET as getSr } from "./sales-returns/[id]/route";
import { POST as postSr } from "./sales-returns/route";

// Part 7 gate through HTTP: customer return request → approve → receive to quarantine →
// evidence upload → inspection from the quarantine list → restocked.
let w: Awaited<ReturnType<typeof seedCompany>>;
let sales: Record<string, string>, whMgr: Record<string, string>, mgr: Record<string, string>;
let reservationId: string;
const url = (p: string) => `http://localhost:3000/api/${p}`;
const send = (h: Record<string, string>, method: string, p: string, body?: unknown) =>
  new Request(url(p), { method, headers: { ...h, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const params = <P>(p: P) => ({ params: Promise.resolve(p) });
const idem = (h: Record<string, string>) => ({ ...h, "idempotency-key": crypto.randomUUID() });
const json = async (res: Response) => ({ status: res.status, body: await res.json() });

beforeAll(async () => {
  w = await seedCompany(`api-ret-${crypto.randomUUID()}`);
  const A = w.warehouse.id;
  [sales, whMgr, mgr] = await Promise.all([
    loginUser(w, "sales_staff", [A]).then((u) => u.signIn()).then((s) => s.headers),
    loginUser(w, "warehouse_manager", [A]).then((u) => u.signIn()).then((s) => s.headers),
    loginUser(w, "inventory_manager").then((u) => u.signIn()).then((s) => s.headers),
  ]);
  const v = w.variants[0].id;
  await transaction((tx) => postMovements(tx, w.ctx, {
    sourceType: "opening", sourceId: "ob-1",
    legs: [{ type: "opening_balance", variantId: v, warehouseId: A, binId: w.warehouse.bins.find((b) => b.code === "MAIN")!.id, delta: { onHand: 5 }, unitCost: 4, line: 1, reasonCode: "opening" }],
  }));
  const r = await transaction((tx) => reserve(tx, w.ctx, { variantId: v, warehouseId: A, qty: 2 }));
  await transaction((tx) => fulfil(tx, w.ctx, { reservationId: r.reservation.id, version: 0 }));
  reservationId = r.reservation.id;
});
afterAll(() => db.$disconnect());

test("customer return: request → approve → receive → evidence → inspect → restocked", async () => {
  const over = await json(await postSr(send(sales, "POST", "sales-returns", { reasonCode: "wrong_size", lines: [{ reservationId, qty: "3" }] })));
  expect([over.status, over.body.code]).toEqual([422, "validation_error"]); // SR-01
  const created = await json(await postSr(send(sales, "POST", "sales-returns", { reasonCode: "wrong_size", lines: [{ reservationId, qty: "2" }] })));
  expect(created.status).toBe(200);
  const id = created.body.id as string;
  const act = (h: Record<string, string>, action: string, body: object) => srAction(send(h, "POST", `sales-returns/${id}/${action}`, body), params({ id, action }));
  expect((await json(await act(sales, "approve", { version: 0 }))).body.code).toBe("forbidden");
  expect((await act(mgr, "approve", { version: 0 })).status).toBe(200);
  expect((await json(await act(whMgr, "receive", { version: 1 }))).body.code).toBe("validation_error"); // Idempotency-Key required
  const rcv = await json(await act(idem(whMgr), "receive", { version: 1 }));
  expect([rcv.status, rcv.body.status]).toEqual([200, "received"]);

  // evidence: multipart upload, content-sniffed
  const form = (bytes: Uint8Array<ArrayBuffer>, name: string) => {
    const f = new FormData();
    f.set("warehouseId", w.warehouse.id);
    f.set("file", new File([bytes], name));
    return new Request(url("evidence"), { method: "POST", headers: mgr, body: f });
  };
  const bad = await json(await upload(form(new TextEncoder().encode("MZ\x90 not a photo"), "photo.jpg")));
  expect([bad.status, bad.body.code]).toEqual([422, "validation_error"]);
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
  const up = await json(await upload(form(jpg, "box.jpg")));
  expect([up.status, up.body.mimeType]).toEqual([200, "image/jpeg"]);

  const lots = (await json(await quarantine(send(mgr, "GET", `quarantine?reason=sale_return&warehouseId=${w.warehouse.id}`)))).body;
  const lot = lots.find((l: { salesReturnLine: { salesReturn: { id: string } } | null }) => l.salesReturnLine?.salesReturn.id === id);
  expect(lot).toMatchObject({ qtyOpen: "2", passBlocker: null });
  const ins = (h: Record<string, string>, body: object) => inspect(send(h, "POST", `quarantine/${lot.id}/inspect`, body), params({ id: lot.id }));
  expect((await json(await ins(idem(whMgr), { disposition: "restockable", qty: "2" }))).body.details.reason).toBe("receiver_is_inspector"); // SR-02
  const ok = await json(await ins(idem(mgr), { disposition: "restockable", qty: "2", evidenceIds: [up.body.id] }));
  expect([ok.status, ok.body.returnStatus]).toEqual([200, "restocked"]);

  const sr = (await json(await getSr(send(sales, "GET", `sales-returns/${id}`), params({ id })))).body;
  expect(sr.status).toBe("restocked");
  expect(sr.movements.map((m: { type: string }) => m.type)).toEqual(["sale_return_quarantine", "sale_return_restock", "putaway_out", "putaway_in"]);
  const file = await getEvidence(send(mgr, "GET", `evidence/${up.body.id}`), params({ id: up.body.id }));
  expect([file.status, file.headers.get("content-type"), file.headers.get("x-content-type-options")]).toEqual([200, "image/jpeg", "nosniff"]);
  expect(new Uint8Array(await file.arrayBuffer())).toEqual(jpg);
  expect(await reconcile(w.ctx)).toEqual([]);
});
