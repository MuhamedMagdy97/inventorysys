import { requestCtx } from "@/server/auth/session-ctx";
import { parseBody, withApi, zId } from "@/server/core/api";
import { AppError } from "@/server/core/errors";
import { execute } from "@/server/core/execute";
import { cancelImport, confirmImport } from "@/server/imports/imports";
import { ImportConfirm } from "../../../schemas";

// Flow 20 phase 2: POST /api/imports/:id/confirm {version, mode} | /cancel {version}.
// Confirm manages its own transactions (a failure must still be recorded in history).
export const POST = withApi<{ id: string; action: string }>(async (req, { params, requestId }) => {
  const ctx = await requestCtx(req, requestId);
  const id = zId.parse(params.id);
  const body = await parseBody(req, ImportConfirm);
  if (params.action === "confirm") return confirmImport(ctx, { id, ...body });
  if (params.action === "cancel") return execute(ctx, { scope: "imports.cancel", entity: { type: "import_job", id } }, (tx) => cancelImport(tx, ctx, { id, version: body.version }));
  throw new AppError("not_found", "Unknown import action");
});
