import { requestCtx } from "@/server/auth/session-ctx";
import { withApi } from "@/server/core/api";
import { getPurchaseReturn } from "@/server/returns/purchase-returns";

export const GET = withApi<{ id: string }>(async (req, { params, requestId }) => getPurchaseReturn(await requestCtx(req, requestId), params.id));
