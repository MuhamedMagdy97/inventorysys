import { z } from "zod";
import { requestCtx } from "@/server/auth/session-ctx";
import { parseQuery, withApi, zPage } from "@/server/core/api";
import { createSupplier, listSuppliers } from "@/server/suppliers/suppliers";
import { mutate } from "../mutate";
import { SupplierCreate } from "../schemas";

const Query = z.object({ ...zPage, q: z.string().max(100).optional(), status: z.enum(["active", "inactive", "archived"]).optional() });

export const GET = withApi(async (req, { requestId }) => {
  const { per_page, ...q } = parseQuery(req, Query);
  return listSuppliers(await requestCtx(req, requestId), { ...q, perPage: per_page });
});

export const POST = withApi((req, { requestId }) =>
  mutate(req, requestId, "suppliers.create", SupplierCreate, (tx, ctx, body) => createSupplier(tx, ctx, body)));
