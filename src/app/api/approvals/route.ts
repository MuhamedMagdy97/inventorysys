import { requestCtx } from "@/server/auth/session-ctx";
import { withApi } from "@/server/core/api";
import { listInbox } from "@/server/approvals/inbox";

// GET /api/approvals — the caller's Approvals Inbox (doc 25); decide via each document's endpoint.
export const GET = withApi(async (req, { requestId }) => listInbox(await requestCtx(req, requestId)));
