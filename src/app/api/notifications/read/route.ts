import { z } from "zod";
import { mutate } from "@/app/api/mutate";
import { withApi, zId } from "@/server/core/api";
import { markRead } from "@/server/notifications/center";

// POST /api/notifications/read {ids?} — mark some (or, without ids, all) as read.
export const POST = withApi(async (req, { requestId }) =>
  mutate(req, requestId, "notifications.read", z.object({ ids: z.array(zId).min(1).max(500).optional() }), (tx, ctx, b) => markRead(tx, ctx, b)));
