import net from "node:net";
import { db } from "@/server/db";
import { writeAudit } from "./audit";
import type { Ctx } from "./ctx";
import { AppError } from "./errors";

// Doc 26 upload virus-scan hook. Every upload path calls assertClean before it parses or
// stores the bytes. ClamAV clamd INSTREAM over TCP; off when CLAMD_HOST is unset (dev/test).
// Fail-closed: a configured scanner that can't answer refuses the upload.

export type ScanResult = { clean: true } | { clean: false; signature: string };
const CHUNK = 64 * 1024; // under clamd's default StreamMaxLength chunking

export function clamdScan(bytes: Uint8Array, opts: { host: string; port: number; timeoutMs?: number }): Promise<ScanResult> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(opts.port, opts.host);
    let reply = "";
    const fail = (e: Error) => { clearTimeout(timer); sock.destroy(); reject(e); };
    const timer = setTimeout(() => fail(new Error("clamd timeout")), opts.timeoutMs ?? 30_000);
    sock.on("error", fail);
    sock.on("connect", () => {
      sock.write("zINSTREAM\0");
      for (let at = 0; at < bytes.byteLength; at += CHUNK) {
        const part = bytes.subarray(at, at + CHUNK);
        const len = Buffer.alloc(4);
        len.writeUInt32BE(part.byteLength);
        sock.write(len);
        sock.write(part);
      }
      sock.write(Buffer.alloc(4)); // zero-length chunk ends the stream
    });
    const done = () => {
      clearTimeout(timer);
      sock.destroy();
      const r = reply.replace(/\0[\s\S]*$/, "").trim(); // "stream: OK" | "stream: <sig> FOUND" | "... ERROR"
      const found = /^stream: (.+) FOUND$/.exec(r);
      if (r === "stream: OK") resolve({ clean: true });
      else if (found) resolve({ clean: false, signature: found[1] });
      else reject(new Error(`clamd: ${r.slice(0, 200) || "no reply"}`));
    };
    sock.on("data", (d) => { reply += d.toString("utf8"); if (reply.includes("\0")) done(); });
    sock.on("end", done);
  });
}

function config() {
  const host = process.env.CLAMD_HOST?.trim();
  return host ? { host, port: Number(process.env.CLAMD_PORT) || 3310 } : null;
}

export async function assertClean(
  ctx: Ctx,
  file: { bytes: Uint8Array; fileName: string; entityType: string; warehouseId?: string | null },
) {
  const cfg = config();
  if (!cfg) return;
  const refuse = async (err: AppError) => {
    // Own connection: the caller's transaction rolls back, the refusal must stay on record.
    await writeAudit(db, ctx, {
      action: "upload.rejected", entityType: file.entityType, entityId: "-", warehouseId: file.warehouseId ?? null,
      reason: err.message, after: { fileName: file.fileName, sizeBytes: file.bytes.byteLength, ...(err.details as object) },
    }).catch((e) => console.error("upload.rejected audit failed", e));
    throw err;
  };
  let res: ScanResult;
  try {
    res = await clamdScan(file.bytes, cfg);
  } catch (e) {
    console.error("virus scan unavailable", e);
    return refuse(new AppError("conflict", "Virus scanner unavailable, try again later", { field: "file", reason: "scan_unavailable" }));
  }
  if (!res.clean) return refuse(new AppError("validation_error", "File is infected", { field: "file", reason: "infected", signature: res.signature }));
}
