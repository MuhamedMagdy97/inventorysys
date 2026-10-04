import { z } from "zod";
import { requestCtx } from "@/server/auth/session-ctx";
import { lookupCodes } from "@/server/catalog/catalog";
import { parseBody, withApi } from "@/server/core/api";

const Body = z.object({ codes: z.array(z.string().min(1).max(64)).min(1).max(200) });

// POST /api/products/lookup — scans (T3.4). Per code: found | ambiguous | not_found,
// with every match; the client asks the operator on ambiguity (P-CAT-02).
// ponytail: rate limit for scan bursts lands with the hardening pass (Part 10).
export const POST = withApi(async (req, { requestId }) => {
  const ctx = await requestCtx(req, requestId);
  const { codes } = await parseBody(req, Body);
  return { results: await lookupCodes(ctx, codes) };
});
