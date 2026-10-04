import { requestCtx } from "@/server/auth/session-ctx";
import { withApi } from "@/server/core/api";
import { getSupplier, updateSupplier } from "@/server/suppliers/suppliers";
import { mutate } from "../../mutate";
import { SupplierPatch } from "../../schemas";

type P = { id: string };

export const GET = withApi<P>(async (req, { params, requestId }) => getSupplier(await requestCtx(req, requestId), params.id));

export const PATCH = withApi<P>((req, { params, requestId }) =>
  mutate(req, requestId, "suppliers.update", SupplierPatch, (tx, ctx, body) => updateSupplier(tx, ctx, { ...body, id: params.id })));
