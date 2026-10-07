import { z } from "zod";
import { requestCtx } from "@/server/auth/session-ctx";
import { parseQuery, withApi, zId, zPage } from "@/server/core/api";
import { createAdjustment, listAdjustments } from "@/server/inventory/adjustments";
import { mutate } from "../mutate";
import { AdjustmentCreate } from "../schemas";

const Query = z.object({
  ...zPage, q: z.string().max(100).optional(), warehouseId: zId.optional(),
  kind: z.enum(["adjustment", "damage", "repair", "disposal"]).optional(),
  status: z.enum(["draft", "submitted", "approved", "applied", "cancelled"]).optional(),
});

export const GET = withApi(async (req, { requestId }) => {
  const { per_page, ...q } = parseQuery(req, Query);
  return listAdjustments(await requestCtx(req, requestId), { ...q, perPage: per_page });
});

// Flows 12/17/27/28: a draft adjustment, damage mark, repair or disposal request.
export const POST = withApi((req, { requestId }) =>
  mutate(req, requestId, "adjustments.create", AdjustmentCreate, (tx, ctx, body) => createAdjustment(tx, ctx, body)));
