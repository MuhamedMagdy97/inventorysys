import { z } from "zod";
import { requestCtx } from "@/server/auth/session-ctx";
import { parseQuery, withApi, zId, zPage } from "@/server/core/api";
import { createSalesReturn, listSalesReturns } from "@/server/returns/sales-returns";
import { mutate } from "../mutate";
import { SalesReturnCreate } from "../schemas";

const Query = z.object({
  ...zPage, q: z.string().max(100).optional(), warehouseId: zId.optional(),
  status: z.enum(["requested", "approved", "received", "inspected", "restocked", "written_off", "rejected", "cancelled"]).optional(),
});

export const GET = withApi(async (req, { requestId }) => {
  const { per_page, ...q } = parseQuery(req, Query);
  return listSalesReturns(await requestCtx(req, requestId), { ...q, perPage: per_page });
});

// Flow 16: a customer return request against fulfilled order lines (SR-01).
export const POST = withApi((req, { requestId }) =>
  mutate(req, requestId, "sales_returns.create", SalesReturnCreate, (tx, ctx, body) => createSalesReturn(tx, ctx, body)));
