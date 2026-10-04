import { requestCtx } from "@/server/auth/session-ctx";
import { withApi } from "@/server/core/api";
import { createWarehouse, listWarehouseCards } from "@/server/warehouses/warehouses";
import { mutate } from "../mutate";
import { WarehouseCreate } from "../schemas";

export const GET = withApi(async (req, { requestId }) => ({ items: await listWarehouseCards(await requestCtx(req, requestId)) }));

// POST /api/warehouses — with the 4 default bins (flow 5).
export const POST = withApi((req, { requestId }) =>
  mutate(req, requestId, "warehouses.create", WarehouseCreate, (tx, ctx, body) => createWarehouse(tx, ctx, body)));
