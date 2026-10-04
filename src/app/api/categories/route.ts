import { z } from "zod";
import { requestCtx } from "@/server/auth/session-ctx";
import { createCategory, listCategories } from "@/server/catalog/taxonomy";
import { parseQuery, withApi } from "@/server/core/api";
import { mutate } from "../mutate";
import { CategoryCreate } from "../schemas";

// GET /api/categories — flat list in tree order (path), with depth.
export const GET = withApi(async (req, { requestId }) => {
  const { includeArchived } = parseQuery(req, z.object({ includeArchived: z.stringbool().optional() }));
  return { items: await listCategories(await requestCtx(req, requestId), { includeArchived }) };
});

export const POST = withApi((req, { requestId }) =>
  mutate(req, requestId, "categories.create", CategoryCreate, (tx, ctx, body) => createCategory(tx, ctx, body)));
