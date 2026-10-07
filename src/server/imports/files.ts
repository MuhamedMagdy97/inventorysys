import { inflateRawSync } from "node:zlib";
import { AppError } from "@/server/core/errors";

// Flow 20 file handling, no dependency: CSV (RFC 4180) and .xlsx (first sheet; a zip of
// XML read with node:zlib). Header row required; header names are lower-cased, spaces → _.

export const MAX_BYTES = 5 * 1024 * 1024;
export const MAX_ROWS = 10_000;

export type Table = { header: string[]; rows: Record<string, string>[] };

export function readTable(fileName: string, bytes: Uint8Array): Table {
  if (bytes.byteLength > MAX_BYTES) throw new AppError("validation_error", "File is larger than 5 MB", { field: "file" });
  const ext = fileName.toLowerCase().split(".").pop();
  if (ext !== "csv" && ext !== "xlsx") throw new AppError("validation_error", "Upload a .csv or .xlsx file", { field: "file" });
  const grid = ext === "csv" ? parseCsv(new TextDecoder("utf-8").decode(bytes)) : readXlsx(Buffer.from(bytes));
  const [head, ...body] = grid.filter((r) => r.some((c) => c.trim() !== ""));
  if (!head) throw new AppError("validation_error", "The file is empty", { field: "file" });
  if (body.length > MAX_ROWS) throw new AppError("validation_error", `At most ${MAX_ROWS} rows per file`, { field: "file" });
  const header = head.map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  return { header, rows: body.map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? "").trim()]))) };
}

export function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(cell); out.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); out.push(row); }
  return out;
}

// Minimal zip reader: central directory → stored (0) or deflated (8) entries.
function unzip(buf: Buffer): Map<string, Buffer> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new AppError("validation_error", "Not a valid .xlsx file", { field: "file" });
  const files = new Map<string, Buffer>();
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = buf.readUInt16LE(eocd + 10); n > 0; n--) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new AppError("validation_error", "Not a valid .xlsx file", { field: "file" });
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extra = buf.readUInt16LE(p + 30), comment = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    if (method === 0 || method === 8) files.set(name, method === 0 ? raw : inflateRawSync(raw));
    p += 46 + nameLen + extra + comment;
  }
  return files;
}

const xmlText = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&amp;/g, "&");
const texts = (xml: string) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => xmlText(m[1])).join("");
const colIndex = (ref: string) => [...ref.replace(/\d+/g, "")].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

export function readXlsx(buf: Buffer): string[][] {
  const files = unzip(buf);
  const sheetName = [...files.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))[0];
  if (!sheetName) throw new AppError("validation_error", "The workbook has no sheet", { field: "file" });
  const shared = [...(files.get("xl/sharedStrings.xml")?.toString("utf8") ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1]));
  const rows: string[][] = [];
  for (const r of files.get(sheetName)!.toString("utf8").matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const row: string[] = [];
    for (const c of r[1].matchAll(/<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1], body = c[2] ?? "";
      const ref = attrs.match(/\br="([A-Z]+\d+)"/)?.[1];
      const type = attrs.match(/\bt="(\w+)"/)?.[1];
      const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      const value = type === "s" ? shared[Number(v)] ?? "" : type === "inlineStr" ? texts(body) : v != null ? xmlText(v) : "";
      row[ref ? colIndex(ref) : row.length] = value;
    }
    rows.push(Array.from(row, (x) => x ?? ""));
  }
  return rows;
}

// Excel stores dates as day serials (1900 system); accept those or ISO dates.
export function parseDate(s: string): Date | undefined {
  if (!s) return undefined;
  if (/^\d+(\.\d+)?$/.test(s)) return new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(s)) * 86_400_000);
  if (!/^\d{4}-\d{2}-\d{2}/.test(s) || Number.isNaN(Date.parse(s))) throw new AppError("validation_error", `Not a date (YYYY-MM-DD): ${s}`);
  return new Date(s.slice(0, 10));
}

export const parseBool = (s: string | undefined) => /^(1|y|yes|true|x)$/i.test(s ?? "");

// CSV out. Text cells starting with = + - @ get a leading ' so spreadsheets don't run them.
export function toCsv(rows: (string | number | null | undefined)[][]): string {
  const cell = (v: string | number | null | undefined) => {
    let s = v == null ? "" : String(v);
    if (typeof v === "string" && /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}
