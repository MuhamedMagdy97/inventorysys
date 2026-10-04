import { withApi } from "@/server/core/api";
import { updateBin } from "@/server/warehouses/warehouses";
import { mutate } from "../../mutate";
import { BinPatch } from "../../schemas";

// PATCH /api/bins/:id — rename/relocate, make default, archive (WH-01/03).
export const PATCH = withApi<{ id: string }>((req, { params, requestId }) =>
  mutate(req, requestId, "bins.update", BinPatch, (tx, ctx, body) => updateBin(tx, ctx, { ...body, id: params.id })));
