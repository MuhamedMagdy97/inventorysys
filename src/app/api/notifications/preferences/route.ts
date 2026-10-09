import { z } from "zod";
import { mutate } from "@/app/api/mutate";
import { requestCtx } from "@/server/auth/session-ctx";
import { withApi } from "@/server/core/api";
import { getPreferences, setPreferences, zCategories } from "@/server/notifications/center";

// GET|PUT /api/notifications/preferences — email opt-in per category (N-02).
export const GET = withApi(async (req, { requestId }) => getPreferences(await requestCtx(req, requestId)));
export const PUT = withApi(async (req, { requestId }) =>
  mutate(req, requestId, "notifications.preferences", z.object({ emailCategories: zCategories }), (tx, ctx, b) => setPreferences(tx, ctx, b)));
