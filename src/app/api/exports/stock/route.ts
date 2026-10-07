import { z } from "zod";
import { requestCtx } from "@/server/auth/session-ctx";
import { parseQuery, withApi, zId } from "@/server/core/api";
import { exportStock } from "@/server/imports/imports";

// Flow 21: GET /api/exports/stock?warehouseId= → CSV (scoped to the caller, audited).
export const GET = withApi(async (req, { requestId }) => {
  const { warehouseId } = parseQuery(req, z.object({ warehouseId: zId.optional() }));
  const out = await exportStock(await requestCtx(req, requestId), { warehouseId });
  return new Response(out.csv, {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${out.fileName}"`, "cache-control": "no-store" },
  });
});
