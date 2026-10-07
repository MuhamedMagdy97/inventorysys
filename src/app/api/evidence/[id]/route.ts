import { requestCtx } from "@/server/auth/session-ctx";
import { withApi } from "@/server/core/api";
import { getEvidence } from "@/server/evidence/evidence";

// GET /api/evidence/:id — the stored file, always as a download with its sniffed type.
export const GET = withApi<{ id: string }>(async (req, { params, requestId }) => {
  const e = await getEvidence(await requestCtx(req, requestId), params.id);
  return new Response(new Uint8Array(e.data), {
    headers: {
      "content-type": e.mimeType,
      "content-disposition": `attachment; filename="${e.fileName.replace(/[^\w.\- ]/g, "_")}"`,
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
    },
  });
});
