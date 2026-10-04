import { z } from "zod";
import { MovementType } from "@/generated/prisma/client";
import { parseQuery, withApi, zId, zPage } from "@/server/core/api";
import { requestCtx } from "@/server/auth/session-ctx";
import { listMovements } from "@/server/inventory/queries";

const Query = z.object({
  ...zPage,
  variantId: zId.optional(),
  warehouseId: zId.optional(),
  type: z.enum(MovementType).optional(),
  sourceType: z.string().max(64).optional(),
  sourceId: z.string().max(200).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

// GET /api/movements — the ledger, newest first.
export const GET = withApi(async (req, { requestId }) => {
  const { per_page, ...q } = parseQuery(req, Query);
  return listMovements(await requestCtx(req, requestId), { ...q, perPage: per_page });
});
