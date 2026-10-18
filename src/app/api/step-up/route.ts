import { z } from "zod";
import { stepUp } from "@/server/auth/step-up";
import { parseBody, withApi } from "@/server/core/api";

const Body = z.object({ password: z.string().min(1).max(256), code: z.string().max(16).optional() });

// POST /api/step-up — re-verify the signed-in session (doc 26). Rate limited in src/proxy.ts.
export const POST = withApi(async (req) => {
  await stepUp(req.headers, await parseBody(req, Body));
  return { ok: true };
});
