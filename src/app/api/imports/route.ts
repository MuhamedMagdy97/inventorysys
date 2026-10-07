import { z } from "zod";
import { requestCtx } from "@/server/auth/session-ctx";
import { parseQuery, withApi, zId, zPage } from "@/server/core/api";
import { AppError } from "@/server/core/errors";
import { MAX_BYTES } from "@/server/imports/files";
import { listImports, previewImport } from "@/server/imports/imports";

export const GET = withApi(async (req, { requestId }) => {
  const { page, per_page } = parseQuery(req, z.object(zPage));
  return listImports(await requestCtx(req, requestId), { page, perPage: per_page });
});

const Fields = z.object({
  type: z.enum(["products", "opening_balance"]),
  warehouseId: zId.optional(),
  asOf: z.coerce.date().optional(),
});

// Flow 20 phase 1: multipart upload (type, file, warehouseId?, asOf?) → validated preview.
export const POST = withApi(async (req, { requestId }) => {
  const ctx = await requestCtx(req, requestId);
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BYTES + 64 * 1024) throw new AppError("validation_error", "File is larger than 5 MB", { field: "file" });
  const form = await req.formData().catch(() => { throw new AppError("validation_error", "Send multipart/form-data with a file"); });
  const file = form.get("file");
  if (!(file instanceof File)) throw new AppError("validation_error", "Attach a file", { field: "file" });
  const fields = Fields.parse({ type: form.get("type"), warehouseId: form.get("warehouseId") || undefined, asOf: form.get("asOf") || undefined });
  return previewImport(ctx, { ...fields, fileName: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
});
