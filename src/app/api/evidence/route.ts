import { requestCtx } from "@/server/auth/session-ctx";
import { withApi, zId } from "@/server/core/api";
import { AppError } from "@/server/core/errors";
import { execute } from "@/server/core/execute";
import { EVIDENCE_MAX_BYTES, uploadEvidence } from "@/server/evidence/evidence";

// POST /api/evidence — multipart `file` + `warehouseId`. Returns the id to pass as
// `evidenceIds` on an inspection or adjustment. Type is sniffed from content, ≤ 10 MB.
export const POST = withApi(async (req, { requestId }) => {
  const ctx = await requestCtx(req, requestId);
  if (Number(req.headers.get("content-length") ?? 0) > EVIDENCE_MAX_BYTES + 64 * 1024) {
    throw new AppError("validation_error", "File is larger than 10 MB", { field: "file", maxBytes: EVIDENCE_MAX_BYTES });
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new AppError("validation_error", "Send multipart/form-data with a `file` field");
  }
  const file = form.get("file");
  if (!(file instanceof File)) throw new AppError("validation_error", "A `file` field is required", { field: "file" });
  const warehouseId = zId.parse(form.get("warehouseId"));
  const bytes = new Uint8Array(await file.arrayBuffer());
  return execute(ctx, { scope: "evidence.upload", entity: { type: "evidence", id: "-" } },
    (tx) => uploadEvidence(tx, ctx, { warehouseId, fileName: file.name, bytes }));
});
