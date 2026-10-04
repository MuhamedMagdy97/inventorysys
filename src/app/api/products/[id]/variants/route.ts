import { addVariant } from "@/server/catalog/catalog";
import { withApi } from "@/server/core/api";
import { mutate } from "../../../mutate";
import { VariantCreate } from "../../../schemas";

// POST /api/products/:id/variants — another SKU on a variant product (P-CAT-03).
export const POST = withApi<{ id: string }>((req, { params, requestId }) =>
  mutate(req, requestId, "variants.create", VariantCreate, (tx, ctx, body) => addVariant(tx, ctx, { ...body, productId: params.id })));
