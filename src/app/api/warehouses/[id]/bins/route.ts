import { withApi } from "@/server/core/api";
import { createBin } from "@/server/warehouses/warehouses";
import { mutate } from "../../../mutate";
import { BinCreate } from "../../../schemas";

export const POST = withApi<{ id: string }>((req, { params, requestId }) =>
  mutate(req, requestId, "bins.create", BinCreate, (tx, ctx, body) => createBin(tx, ctx, { ...body, warehouseId: params.id })));
