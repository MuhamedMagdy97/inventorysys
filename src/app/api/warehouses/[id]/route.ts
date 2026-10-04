import { requestCtx } from "@/server/auth/session-ctx";
import { withApi } from "@/server/core/api";
import { getWarehouse, updateWarehouse } from "@/server/warehouses/warehouses";
import { mutate } from "../../mutate";
import { WarehousePatch } from "../../schemas";

type P = { id: string };

export const GET = withApi<P>(async (req, { params, requestId }) => getWarehouse(await requestCtx(req, requestId), params.id));

// PATCH /api/warehouses/:id — edit, manager, status (archive guarded by WH-02).
export const PATCH = withApi<P>((req, { params, requestId }) =>
  mutate(req, requestId, "warehouses.update", WarehousePatch, (tx, ctx, body) => updateWarehouse(tx, ctx, { ...body, id: params.id })));
