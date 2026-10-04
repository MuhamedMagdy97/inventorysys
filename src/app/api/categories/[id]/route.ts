import { setCategoryArchived, updateCategory } from "@/server/catalog/taxonomy";
import { withApi } from "@/server/core/api";
import { mutate } from "../../mutate";
import { CategoryPatch } from "../../schemas";

// PATCH /api/categories/:id — { archived } archives/re-activates; otherwise rename/move
// (cycle + depth guarded).
export const PATCH = withApi<{ id: string }>((req, { params, requestId }) =>
  mutate(req, requestId, "categories.update", CategoryPatch, (tx, ctx, { archived, ...body }) =>
    archived === undefined
      ? updateCategory(tx, ctx, { ...body, id: params.id })
      : setCategoryArchived(tx, ctx, { id: params.id, version: body.version, archived })));
