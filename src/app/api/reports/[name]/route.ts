import { requestCtx } from "@/server/auth/session-ctx";
import { withApi } from "@/server/core/api";
import { AppError } from "@/server/core/errors";
import { exportReport, isReport, ReportFilters, runReport } from "@/server/reports/reports";

// GET /api/reports/:name?warehouseId=&categoryId=&brandId=&variantId=&from=&to=&…  (doc 16)
// `format=csv` → the same report as an audited CSV download (reports.export).
export const GET = withApi<{ name: string }>(async (req, { params, requestId }) => {
  if (!isReport(params.name)) throw new AppError("not_found", "Unknown report");
  const url = new URL(req.url);
  const filters = ReportFilters.parse(Object.fromEntries([...url.searchParams].filter(([k, v]) => k !== "format" && v !== "")));
  const ctx = await requestCtx(req, requestId);
  if (url.searchParams.get("format") !== "csv") return runReport(ctx, params.name, filters);
  const out = await exportReport(ctx, params.name, filters);
  return new Response(out.csv, {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${out.fileName}"`, "cache-control": "no-store" },
  });
});
