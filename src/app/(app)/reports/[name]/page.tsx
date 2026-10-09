import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { MovementType } from "@/generated/prisma/client";
import { Denied } from "@/app/ui/denied";
import { pageData } from "@/server/auth/page-ctx";
import { scopeFilter } from "@/server/core/ctx";
import { db } from "@/server/db";
import { isReport, REPORTS, ReportFilters, runReport } from "@/server/reports/reports";

export const metadata: Metadata = { title: "Report" };

export default async function ReportPage({ params, searchParams }: PageProps<"/reports/[name]">) {
  const { name } = await params;
  if (!isReport(name)) notFound();
  const def = REPORTS[name];
  const raw = Object.fromEntries(Object.entries(await searchParams).filter(([, v]) => typeof v === "string" && v !== "")) as Record<string, string>;
  const parsed = ReportFilters.safeParse(raw);
  const res = await pageData(async (ctx) => ({
    report: parsed.success ? await runReport(ctx, name, parsed.data) : null,
    canExport: ctx.permissions.has("reports.export"),
    warehouses: await db.warehouse.findMany({ where: { companyId: ctx.companyId, id: scopeFilter(ctx) }, orderBy: { code: "asc" }, select: { id: true, code: true } }),
    categories: await db.category.findMany({ where: { companyId: ctx.companyId, archived: false }, orderBy: { path: "asc" }, select: { id: true, path: true } }),
    brands: await db.brand.findMany({ where: { companyId: ctx.companyId, archived: false }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
  }));
  if ("denied" in res) return <Denied message={res.denied} />;
  const { report, canExport, warehouses, categories, brands } = res.data;
  const f = def.filters as readonly string[];
  const csv = `/api/reports/${name}?${new URLSearchParams({ ...raw, format: "csv" })}`;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/reports" className="link text-sm">← Reports</Link>
          <h1 className="h1">{def.title}</h1>
          <p className="text-sm text-muted">{def.about}</p>
        </div>
        {canExport && report && <a href={csv} className="btn">Export CSV</a>}
      </div>

      <form className="card flex flex-wrap items-end gap-3">
        <label className="label">Warehouse
          <select name="warehouseId" defaultValue={raw.warehouseId} className="input"><option value="">All I can see</option>{warehouses.map((w) => <option key={w.id} value={w.id}>{w.code}</option>)}</select>
        </label>
        {f.includes("product") && <>
          <label className="label">Category
            <select name="categoryId" defaultValue={raw.categoryId} className="input"><option value="">All</option>{categories.map((c) => <option key={c.id} value={c.id}>{c.path}</option>)}</select>
          </label>
          <label className="label">Brand
            <select name="brandId" defaultValue={raw.brandId} className="input"><option value="">All</option>{brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
          </label>
        </>}
        {f.includes("dates") && <>
          <label className="label">From<input type="date" name="from" defaultValue={raw.from} className="input" /></label>
          <label className="label">To<input type="date" name="to" defaultValue={raw.to} className="input" /></label>
        </>}
        {f.includes("ledger") && <>
          <label className="label">Type
            <select name="type" defaultValue={raw.type} className="input"><option value="">All</option>{Object.values(MovementType).map((t) => <option key={t}>{t}</option>)}</select>
          </label>
          <label className="label">Source type<input name="sourceType" defaultValue={raw.sourceType} className="input" /></label>
          <label className="label">Rows (max 10 000)<input type="number" name="limit" min={1} max={10000} defaultValue={raw.limit ?? 1000} className="input" /></label>
          {raw.variantId && <input type="hidden" name="variantId" value={raw.variantId} />}
        </>}
        {f.includes("valuation") && <>
          <label className="label">Group by
            <select name="groupBy" defaultValue={raw.groupBy} className="input"><option value="variant">SKU</option><option value="warehouse">Warehouse</option><option value="category">Category</option></select>
          </label>
          <label className="label">As of (blank = now)<input type="date" name="asOf" defaultValue={raw.asOf} className="input" /></label>
        </>}
        <button className="btn-primary">Run</button>
      </form>

      {!parsed.success && <p role="alert" className="text-sm text-red-600">Invalid filters: {parsed.error.issues.map((i) => i.path.join(".")).join(", ")}</p>}
      {report?.notes.map((n) => <p key={n} className="text-sm text-muted">{n}</p>)}
      {report?.sections.map((sec, i) => (
        <section key={i} className="flex flex-col gap-2">
          {sec.title && <h2 className="font-semibold">{sec.title}</h2>}
          <div className="card overflow-x-auto p-0">
            <table className="table">
              <thead><tr>{sec.columns.map(([k, label]) => <th key={k} className="whitespace-nowrap">{label}</th>)}</tr></thead>
              <tbody>
                {sec.rows.length === 0 && <tr><td colSpan={sec.columns.length} className="text-muted">Nothing to show for these filters.</td></tr>}
                {sec.rows.map((row, j) => (
                  <tr key={j}>{sec.columns.map(([k]) => <td key={k} className={typeof row[k] === "number" || /^-?\d+(\.\d+)?$/.test(String(row[k] ?? "")) ? "text-right tabular-nums" : ""}>{row[k] ?? ""}</td>)}</tr>
                ))}
                {sec.total && <tr className="font-semibold">{sec.columns.map(([k]) => <td key={k} className="text-right tabular-nums">{sec.total![k] ?? ""}</td>)}</tr>}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}
