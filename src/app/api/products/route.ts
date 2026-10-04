import { z } from "zod";
import { requestCtx } from "@/server/auth/session-ctx";
import { createProduct, listProducts } from "@/server/catalog/catalog";
import { parseQuery, withApi, zId, zPage } from "@/server/core/api";
import { mutate } from "../mutate";
import { ProductCreate } from "../schemas";

const Query = z.object({
  ...zPage,
  q: z.string().max(100).optional(),
  categoryId: zId.optional(),
  brandId: zId.optional(),
  status: z.enum(["draft", "active", "inactive", "discontinued", "archived"]).optional(),
});

// GET /api/products — archived hidden unless ?status=archived (P-CAT-07).
export const GET = withApi(async (req, { requestId }) => {
  const { per_page, ...q } = parseQuery(req, Query);
  return listProducts(await requestCtx(req, requestId), { ...q, perPage: per_page });
});

// POST /api/products — product + its variant(s) (flow 1).
export const POST = withApi((req, { requestId }) =>
  mutate(req, requestId, "products.create", ProductCreate, (tx, ctx, body) => createProduct(tx, ctx, body)));
