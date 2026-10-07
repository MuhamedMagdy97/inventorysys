import { z } from "zod";
import { requestCtx } from "@/server/auth/session-ctx";
import { parseQuery, withApi, zId, zPage } from "@/server/core/api";
import { listCounts, openCount } from "@/server/inventory/counts";
import { mutate } from "../mutate";
import { CountCreate } from "../schemas";

const Query = z.object({
  ...zPage, q: z.string().max(100).optional(), warehouseId: zId.optional(),
  status: z.enum(["open", "counting", "variance_review", "approved", "applied", "cancelled"]).optional(),
});

export const GET = withApi(async (req, { requestId }) => {
  const { per_page, ...q } = parseQuery(req, Query);
  return listCounts(await requestCtx(req, requestId), { ...q, perPage: per_page });
});

// Flow 19: open a count — the snapshot is taken now.
export const POST = withApi((req, { requestId }) =>
  mutate(req, requestId, "counts.open", CountCreate, (tx, ctx, body) => openCount(tx, ctx, body)));
