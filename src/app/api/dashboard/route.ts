import { requestCtx } from "@/server/auth/session-ctx";
import { withApi } from "@/server/core/api";
import { getDashboard } from "@/server/reports/dashboard";

// GET /api/dashboard — doc 16 §1 KPIs, charts, tables, alerts (caller's scope).
export const GET = withApi(async (req, { requestId }) => getDashboard(await requestCtx(req, requestId)));
