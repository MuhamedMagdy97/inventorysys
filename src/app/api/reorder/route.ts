import { z } from "zod";
import { requestCtx } from "@/server/auth/session-ctx";
import { parseQuery, withApi, zId } from "@/server/core/api";
import { createReorderPos, listReorderSuggestions } from "@/server/purchasing/reorder";
import { mutate } from "../mutate";
import { ReorderCreate } from "../schemas";

// Doc 09 §6: GET = suggestions (RO-02…04), POST = draft POs from the user's selection (RO-05).
const Query = z.object({ warehouseId: zId.optional() });

export const GET = withApi(async (req, { requestId }) =>
  listReorderSuggestions(await requestCtx(req, requestId), parseQuery(req, Query)));

export const POST = withApi((req, { requestId }) =>
  mutate(req, requestId, "reorder.create_pos", ReorderCreate, (tx, ctx, body) => createReorderPos(tx, ctx, body)));
