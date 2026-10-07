import { z } from "zod";
import { requestCtx } from "@/server/auth/session-ctx";
import { parseQuery, withApi, zId, zPage } from "@/server/core/api";
import { createPurchaseReturn, listPurchaseReturns } from "@/server/returns/purchase-returns";
import { mutate } from "../mutate";
import { PurchaseReturnCreate } from "../schemas";

const Query = z.object({
  ...zPage, q: z.string().max(100).optional(), poId: zId.optional(),
  status: z.enum(["draft", "submitted", "approved", "shipped", "supplier_confirmed", "supplier_rejected", "closed", "cancelled"]).optional(),
});

export const GET = withApi(async (req, { requestId }) => {
  const { per_page, ...q } = parseQuery(req, Query);
  return listPurchaseReturns(await requestCtx(req, requestId), { ...q, perPage: per_page });
});

// Flow 8: a draft return to the supplier; lines link to receipt lots (oldest first by default).
export const POST = withApi((req, { requestId }) =>
  mutate(req, requestId, "purchase_returns.create", PurchaseReturnCreate, (tx, ctx, body) => createPurchaseReturn(tx, ctx, body)));
