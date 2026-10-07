import { requestCtx } from "@/server/auth/session-ctx";
import { withApi } from "@/server/core/api";
import { getAdjustment } from "@/server/inventory/adjustments";

export const GET = withApi<{ id: string }>(async (req, { params, requestId }) => getAdjustment(await requestCtx(req, requestId), params.id));
