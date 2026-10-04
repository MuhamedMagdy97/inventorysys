import { z } from "zod";
import { requestCtx } from "@/server/auth/session-ctx";
import { createBrand, listBrands } from "@/server/catalog/taxonomy";
import { parseQuery, withApi } from "@/server/core/api";
import { mutate } from "../mutate";
import { BrandCreate } from "../schemas";

export const GET = withApi(async (req, { requestId }) => {
  const { includeArchived } = parseQuery(req, z.object({ includeArchived: z.stringbool().optional() }));
  return { items: await listBrands(await requestCtx(req, requestId), { includeArchived }) };
});

export const POST = withApi((req, { requestId }) =>
  mutate(req, requestId, "brands.create", BrandCreate, (tx, ctx, body) => createBrand(tx, ctx, body)));
