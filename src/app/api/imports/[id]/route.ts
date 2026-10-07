import { requestCtx } from "@/server/auth/session-ctx";
import { withApi } from "@/server/core/api";
import { getImport } from "@/server/imports/imports";

export const GET = withApi<{ id: string }>(async (req, { params, requestId }) => getImport(await requestCtx(req, requestId), params.id));
