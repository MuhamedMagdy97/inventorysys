import { requestCtx } from "@/server/auth/session-ctx";
import { withApi } from "@/server/core/api";
import { getPo, updatePo } from "@/server/purchasing/purchase-orders";
import { mutate } from "../../mutate";
import { PoPatch } from "../../schemas";

type P = { id: string };

export const GET = withApi<P>(async (req, { params, requestId }) => getPo(await requestCtx(req, requestId), params.id));

// Draft edit only (PO-09).
export const PATCH = withApi<P>((req, { params, requestId }) =>
  mutate(req, requestId, "purchase_orders.update", PoPatch, (tx, ctx, body) => updatePo(tx, ctx, { ...body, id: params.id })));
