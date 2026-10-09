import { z } from "zod";
import { requestCtx } from "@/server/auth/session-ctx";
import { parseQuery, withApi } from "@/server/core/api";
import { search } from "@/server/search/search";

// GET /api/search?q= — global scoped search (doc 25).
export const GET = withApi(async (req, { requestId }) => search(await requestCtx(req, requestId), parseQuery(req, z.object({ q: z.string() }))));
