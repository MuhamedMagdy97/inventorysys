import { z } from "zod";
import { requestCtx } from "@/server/auth/session-ctx";
import { parseQuery, withApi, zPage } from "@/server/core/api";
import { listNotifications } from "@/server/notifications/center";

const Query = z.object({ ...zPage, unread: z.enum(["1", "true"]).optional() });

// GET /api/notifications — the caller's notification center, newest first (doc 25).
export const GET = withApi(async (req, { requestId }) => {
  const q = parseQuery(req, Query);
  return listNotifications(await requestCtx(req, requestId), { page: q.page, perPage: q.per_page, unreadOnly: !!q.unread });
});
