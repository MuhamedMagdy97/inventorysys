import { updateVariant } from "@/server/catalog/catalog";
import { withApi } from "@/server/core/api";
import { mutate } from "../../mutate";
import { VariantPatch } from "../../schemas";

// PATCH /api/variants/:id — SKU editable until first movement, barcode change keeps an alias.
export const PATCH = withApi<{ id: string }>((req, { params, requestId }) =>
  mutate(req, requestId, "variants.update", VariantPatch, (tx, ctx, body) => updateVariant(tx, ctx, { ...body, id: params.id })));
