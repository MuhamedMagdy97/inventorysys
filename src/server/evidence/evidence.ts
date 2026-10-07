import { createHash } from "node:crypto";
import { writeAudit } from "@/server/core/audit";
import { requirePermission, type Ctx } from "@/server/core/ctx";
import { AppError } from "@/server/core/errors";
import { db, type Tx } from "@/server/db";

// Evidence photos / PDFs (doc 26 uploads, edge #28). The type comes from the file's
// own bytes, never the client's name or header; size is capped. A refused upload is
// audited on its own connection, so it survives the rollback.
// ponytail: stored in Postgres (bytea) and no virus-scan hook yet — move to object
// storage + a scanner when volume or policy needs it.

export const EVIDENCE_MAX_BYTES = 10 * 1024 * 1024;
const ascii = (b: Uint8Array, at: number, s: string) => [...s].every((c, i) => b[at + i] === c.charCodeAt(0));
const SNIFF: { mime: string; ext: string; is: (b: Uint8Array) => boolean }[] = [
  { mime: "image/jpeg", ext: "jpg", is: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: "image/png", ext: "png", is: (b) => [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((x, i) => b[i] === x) },
  { mime: "image/webp", ext: "webp", is: (b) => ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP") },
  { mime: "application/pdf", ext: "pdf", is: (b) => ascii(b, 0, "%PDF-") },
];
// Grants whose holders attach evidence to something (inspection, damage, adjustment).
const UPLOADERS = ["inventory.inspect", "sales.return_inspect", "sales.return_receive", "inventory.damage_mark", "inventory.adjust_create"];

export async function uploadEvidence(tx: Tx, ctx: Ctx, input: { warehouseId: string; fileName: string; bytes: Uint8Array }) {
  await requirePermission(ctx, UPLOADERS, { warehouseId: input.warehouseId });
  const wh = await tx.warehouse.findFirst({ where: { id: input.warehouseId, companyId: ctx.companyId }, select: { id: true } });
  if (!wh) throw new AppError("validation_error", "Unknown warehouse", { field: "warehouseId" });
  const fileName = (input.fileName.split(/[\\/]/).pop() ?? "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 200) || "evidence";
  const size = input.bytes.byteLength;
  const kind = SNIFF.find((k) => k.is(input.bytes));
  const refusal = size === 0 ? "File is empty"
    : size > EVIDENCE_MAX_BYTES ? `File is larger than ${EVIDENCE_MAX_BYTES / 1024 / 1024} MB`
    : !kind ? "Only JPEG, PNG, WebP or PDF files are accepted"
    : null;
  if (refusal) {
    await writeAudit(db, ctx, {
      action: "upload.rejected", entityType: "evidence", entityId: "-", warehouseId: input.warehouseId,
      reason: refusal, after: { fileName, sizeBytes: size },
    }).catch((e) => console.error("upload.rejected audit failed", e));
    throw new AppError("validation_error", refusal, { field: "file", maxBytes: EVIDENCE_MAX_BYTES });
  }
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const row = await tx.evidence.create({
    data: {
      companyId: ctx.companyId, warehouseId: wh.id, fileName, mimeType: kind!.mime, sizeBytes: size, sha256,
      data: Buffer.from(input.bytes), uploadedBy: ctx.userId,
    },
    select: { id: true, fileName: true, mimeType: true, sizeBytes: true, sha256: true, createdAt: true },
  });
  await writeAudit(tx, ctx, { action: "upload", entityType: "evidence", entityId: row.id, warehouseId: wh.id, after: row });
  return row;
}

// Links not-yet-attached uploads of that warehouse to the document they support.
export async function attachEvidence(tx: Tx, ctx: Ctx, ids: string[] | undefined, entity: { type: string; id: string; warehouseId: string }) {
  const unique = [...new Set(ids ?? [])];
  if (!unique.length) return [];
  const res = await tx.evidence.updateMany({
    where: { id: { in: unique }, companyId: ctx.companyId, warehouseId: entity.warehouseId, entityId: null },
    data: { entityType: entity.type, entityId: entity.id },
  });
  if (res.count !== unique.length) throw new AppError("validation_error", "Evidence not found, already attached, or from another warehouse", { field: "evidenceIds" });
  return unique;
}

export async function getEvidence(ctx: Ctx, id: string) {
  const e = await db.evidence.findFirst({ where: { id, companyId: ctx.companyId } });
  if (!e) throw new AppError("not_found", "Evidence not found");
  await requirePermission(ctx, ["inventory.view", "sales.view", "purchases.view"], { warehouseId: e.warehouseId });
  return e;
}

export const listEvidence = (ctx: Ctx, entityType: string, entityIds: string[]) =>
  db.evidence.findMany({
    where: { companyId: ctx.companyId, entityType, entityId: { in: entityIds } },
    select: { id: true, entityId: true, fileName: true, mimeType: true, sizeBytes: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
