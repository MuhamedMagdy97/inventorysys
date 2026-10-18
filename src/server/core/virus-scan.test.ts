import net from "node:net";
import { afterAll, afterEach, expect, test } from "vitest";
import { db } from "@/server/db";
import { seedCompany } from "@/server/seed";
import { loginUser } from "@/test/auth";
import { POST as uploadRoute } from "@/app/api/evidence/route";
import { clamdScan } from "./virus-scan";

// Fake clamd: parses zINSTREAM framing, hands the reassembled payload to `reply`
// (null = never answer, to exercise the timeout).
async function fakeClamd(reply: (payload: Buffer) => string | null) {
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      const cmd = Buffer.from("zINSTREAM\0");
      if (buf.length < cmd.length) return;
      expect(buf.subarray(0, cmd.length)).toEqual(cmd);
      const parts: Buffer[] = [];
      for (let at = cmd.length; at + 4 <= buf.length;) {
        const n = buf.readUInt32BE(at);
        if (n === 0) {
          const r = reply(Buffer.concat(parts));
          if (r !== null) sock.end(`stream: ${r}\0`);
          return;
        }
        if (at + 4 + n > buf.length) return; // wait for the rest of the chunk
        parts.push(buf.subarray(at + 4, at + 4 + n));
        at += 4 + n;
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { port: (server.address() as net.AddressInfo).port, close: () => new Promise((r) => server.close(r)) };
}

const EICAR = Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*");
const clamav = (p: Buffer) => (p.includes(EICAR) ? "Eicar-Test-Signature FOUND" : "OK");

afterEach(() => { delete process.env.CLAMD_HOST; delete process.env.CLAMD_PORT; });
afterAll(() => db.$disconnect());

test("clamd INSTREAM: OK and FOUND, payload framed in chunks", async () => {
  const seen: number[] = [];
  const s = await fakeClamd((p) => { seen.push(p.length); return clamav(p); });
  const big = new Uint8Array(200_000).fill(7); // > one 64 KB chunk
  expect(await clamdScan(big, { host: "127.0.0.1", port: s.port })).toEqual({ clean: true });
  expect(await clamdScan(EICAR, { host: "127.0.0.1", port: s.port })).toEqual({ clean: false, signature: "Eicar-Test-Signature" });
  expect(seen).toEqual([200_000, EICAR.length]);
  await s.close();
});

test("clamd: timeout, refused connection and an ERROR reply all reject", async () => {
  const silent = await fakeClamd(() => null);
  await expect(clamdScan(EICAR, { host: "127.0.0.1", port: silent.port, timeoutMs: 200 })).rejects.toThrow("clamd timeout");
  await silent.close();
  await expect(clamdScan(EICAR, { host: "127.0.0.1", port: silent.port })).rejects.toThrow(); // nothing listening now
  const err = await fakeClamd(() => "INSTREAM size limit exceeded. ERROR");
  await expect(clamdScan(EICAR, { host: "127.0.0.1", port: err.port })).rejects.toThrow(/ERROR/);
  await err.close();
});

test("evidence upload: infected file refused + audited, nothing stored; scanner down fails closed", async () => {
  const w = await seedCompany(`scan-${crypto.randomUUID()}`);
  const { headers } = await loginUser(w, "inventory_manager").then((u) => u.signIn());
  const send = (bytes: Uint8Array) => {
    const f = new FormData();
    f.set("warehouseId", w.warehouse.id);
    f.set("file", new File([Buffer.from(bytes)], "scan.pdf"));
    return uploadRoute(new Request("http://localhost:3000/api/evidence", { method: "POST", headers, body: f }));
  };
  const pdf = (body: Buffer) => Buffer.concat([Buffer.from("%PDF-1.4\n"), body]); // passes the type sniff
  const s = await fakeClamd(clamav);
  process.env.CLAMD_HOST = "127.0.0.1";
  process.env.CLAMD_PORT = String(s.port);

  const bad = await send(pdf(EICAR));
  const body = await bad.json();
  expect([bad.status, body.code, body.details.reason, body.details.signature]).toEqual([422, "validation_error", "infected", "Eicar-Test-Signature"]);
  expect(await db.evidence.count({ where: { companyId: w.ctx.companyId } })).toBe(0);
  const audit = await db.auditLog.findFirst({ where: { companyId: w.ctx.companyId, action: "upload.rejected" } });
  expect(audit).toMatchObject({ entityType: "evidence", reason: "File is infected" });

  expect((await send(pdf(Buffer.from("clean")))).status).toBe(200);
  await s.close();

  const down = await send(pdf(Buffer.from("clean")));
  expect([down.status, (await down.json()).details.reason]).toEqual([409, "scan_unavailable"]);
  expect(await db.evidence.count({ where: { companyId: w.ctx.companyId } })).toBe(1);
});
