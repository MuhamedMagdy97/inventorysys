import { z } from "zod";
import { requestCtx } from "@/server/auth/session-ctx";
import { parseQuery, withApi, zId, zPage } from "@/server/core/api";
import { createTransfer, listTransfers } from "@/server/inventory/transfers";
import { mutate } from "../mutate";
import { TransferCreate } from "../schemas";

const Query = z.object({
  ...zPage, q: z.string().max(100).optional(), warehouseId: zId.optional(),
  status: z.enum(["draft", "submitted", "approved", "in_transit", "partially_received", "completed", "closed_with_variance", "cancelled"]).optional(),
});

export const GET = withApi(async (req, { requestId }) => {
  const { per_page, ...q } = parseQuery(req, Query);
  return listTransfers(await requestCtx(req, requestId), { ...q, perPage: per_page });
});

// Flow 9: request a transfer (draft). ATP at request time is advisory → `warnings`.
export const POST = withApi((req, { requestId }) =>
  mutate(req, requestId, "transfers.create", TransferCreate, (tx, ctx, body) => createTransfer(tx, ctx, body)));
