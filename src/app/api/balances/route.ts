import { z } from "zod";
import { parseQuery, withApi, zId, zPage } from "@/server/core/api";
import { requestCtx } from "@/server/auth/session-ctx";
import { listBalances } from "@/server/inventory/queries";

const Query = z.object({
  ...zPage,
  variantId: zId.optional(),
  warehouseId: zId.optional(),
  binId: zId.optional(),
  batchId: zId.optional(),
  nonZero: z.stringbool().optional(),
});

// GET /api/balances — physical buckets per bin.
export const GET = withApi(async (req, { requestId }) => {
  const { per_page, ...q } = parseQuery(req, Query);
  return listBalances(await requestCtx(req, requestId), { ...q, perPage: per_page });
});
