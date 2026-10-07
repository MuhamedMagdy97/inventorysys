import { requestCtx } from "@/server/auth/session-ctx";
import { withApi } from "@/server/core/api";
import { getCount } from "@/server/inventory/counts";

// Snapshot, entries and the live variance view (current qty, what apply would leave).
export const GET = withApi<{ id: string }>(async (req, { params, requestId }) => getCount(await requestCtx(req, requestId), params.id));
