import { z } from "zod";
import { requestCtx } from "@/server/auth/session-ctx";
import { parseQuery, withApi, zId } from "@/server/core/api";
import { listQuarantine } from "@/server/inventory/inspection";

const Query = z.object({ warehouseId: zId.optional(), reason: z.string().max(50).optional() });

// GET /api/quarantine — open quarantine lots by reason (doc 25 Inspection).
export const GET = withApi(async (req, { requestId }) =>
  listQuarantine(await requestCtx(req, requestId), parseQuery(req, Query)));
