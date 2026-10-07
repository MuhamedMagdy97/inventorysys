import { requestCtx } from "@/server/auth/session-ctx";
import { withApi } from "@/server/core/api";
import { getTransfer } from "@/server/inventory/transfers";

export const GET = withApi<{ id: string }>(async (req, { params, requestId }) => getTransfer(await requestCtx(req, requestId), params.id));
