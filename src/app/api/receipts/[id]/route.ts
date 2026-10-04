import { requestCtx } from "@/server/auth/session-ctx";
import { withApi } from "@/server/core/api";
import { getReceipt } from "@/server/purchasing/receipts";

export const GET = withApi<{ id: string }>(async (req, { params, requestId }) => getReceipt(await requestCtx(req, requestId), params.id));
