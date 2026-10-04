import { z } from "zod";
import { parseQuery, withApi, zId } from "@/server/core/api";
import { requestCtx } from "@/server/core/request-ctx";
import { getAvailability } from "@/server/inventory/availability";

const Query = z.object({ variantId: zId, warehouseId: zId.optional() });

// GET /api/availability?variantId&warehouseId — ATP (INV-001).
export const GET = withApi(async (req, { requestId }) =>
  getAvailability(await requestCtx(requestId), parseQuery(req, Query)));
