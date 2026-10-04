import { requestCtx } from "@/server/auth/session-ctx";
import { getProduct, updateProduct } from "@/server/catalog/catalog";
import { withApi } from "@/server/core/api";
import { mutate } from "../../mutate";
import { ProductPatch } from "../../schemas";

type P = { id: string };

export const GET = withApi<P>(async (req, { params, requestId }) => getProduct(await requestCtx(req, requestId), params.id));

// PATCH /api/products/:id — edit, status transitions (incl. archive), frozen flags (P-CAT-05).
export const PATCH = withApi<P>((req, { params, requestId }) =>
  mutate(req, requestId, "products.update", ProductPatch, (tx, ctx, body) => updateProduct(tx, ctx, { ...body, id: params.id })));
