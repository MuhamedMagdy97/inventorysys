import { z } from "zod";
import { requestCtx } from "@/server/auth/session-ctx";
import { parseQuery, withApi, zId, zPage } from "@/server/core/api";
import { createPo, listPos } from "@/server/purchasing/purchase-orders";
import { mutate } from "../mutate";
import { PoCreate } from "../schemas";

const Query = z.object({
  ...zPage, q: z.string().max(100).optional(), supplierId: zId.optional(), warehouseId: zId.optional(),
  status: z.enum(["draft", "submitted", "approved", "ordered", "partially_received", "fully_received", "closed", "cancelled"]).optional(),
});

export const GET = withApi(async (req, { requestId }) => {
  const { per_page, ...q } = parseQuery(req, Query);
  return listPos(await requestCtx(req, requestId), { ...q, perPage: per_page });
});

export const POST = withApi((req, { requestId }) =>
  mutate(req, requestId, "purchase_orders.create", PoCreate, (tx, ctx, body) => createPo(tx, ctx, body)));
