import { requestCtx } from "@/server/auth/session-ctx";
import { withApi } from "@/server/core/api";
import { getSalesReturn } from "@/server/returns/sales-returns";

export const GET = withApi<{ id: string }>(async (req, { params, requestId }) => getSalesReturn(await requestCtx(req, requestId), params.id));
