import type { Metadata } from "next";
import Link from "next/link";
import { Denied } from "@/app/ui/denied";
import { pageData } from "@/server/auth/page-ctx";
import { requirePermission } from "@/server/core/ctx";
import { REPORTS } from "@/server/reports/reports";

export const metadata: Metadata = { title: "Reports" };

// Doc 16 §2 V1 catalog. Each report: filters → preview → CSV export.
export default async function ReportsPage() {
  const res = await pageData((ctx) => requirePermission(ctx, "reports.view"));
  if ("denied" in res) return <Denied message={res.denied} />;
  return (
    <div className="flex max-w-4xl flex-col gap-4">
      <h1 className="h1">Reports</h1>
      <div className="grid gap-3 sm:grid-cols-2">
        {Object.entries(REPORTS).map(([name, r]) => (
          <Link key={name} href={`/reports/${name}`} className="card hover:border-accent">
            <h2 className="font-semibold">{r.title}</h2>
            <p className="mt-1 text-sm text-muted">{r.about}</p>
          </Link>
        ))}
      </div>
      <p className="text-xs text-muted">Every report covers only the warehouses you are assigned to. Exports are CSV (opens in Excel) and are recorded in the audit log.</p>
    </div>
  );
}
