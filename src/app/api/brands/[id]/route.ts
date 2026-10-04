import { updateBrand } from "@/server/catalog/taxonomy";
import { withApi } from "@/server/core/api";
import { mutate } from "../../mutate";
import { BrandPatch } from "../../schemas";

export const PATCH = withApi<{ id: string }>((req, { params, requestId }) =>
  mutate(req, requestId, "brands.update", BrandPatch, (tx, ctx, body) => updateBrand(tx, ctx, { ...body, id: params.id })));
