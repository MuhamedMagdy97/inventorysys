import { z } from "zod";
import { replaceSku } from "@/server/catalog/catalog";
import { withApi } from "@/server/core/api";
import { mutate } from "../../../mutate";
import { zVersion } from "../../../schemas";

// POST /api/variants/:id/replace-sku — P-CAT-01 alias flow after stock has moved.
export const POST = withApi<{ id: string }>((req, { params, requestId }) =>
  mutate(req, requestId, "variants.replace_sku", z.object({ ...zVersion, newSku: z.string().max(40) }),
    (tx, ctx, body) => replaceSku(tx, ctx, { ...body, variantId: params.id })));
