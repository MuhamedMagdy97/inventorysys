import type { Metadata } from "next";
import Link from "next/link";
import type { AdjustmentKind, AdjustmentStatus } from "@/generated/prisma/client";
import { Denied } from "@/app/ui/denied";
import { pageData } from "@/server/auth/page-ctx";
import { listAdjustments } from "@/server/inventory/adjustments";

export const metadata: Metadata = { title: "Adjustments" };

const STATUSES: AdjustmentStatus[] = ["draft", "submitted", "approved", "applied", "cancelled"];
const KINDS: AdjustmentKind[] = ["adjustment", "damage", "repair", "disposal", "opening"];

export default async function AdjustmentsPage({ searchParams }: PageProps<"/adjustments">) {
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q : undefined;
  const status = STATUSES.find((s) => s === sp.status);
  const kind = KINDS.find((k) => k === sp.kind);
  const res = await pageData(async (ctx) => ({
    list: await listAdjustments(ctx, { page: 1, perPage: 200, q, status, kind }), // ponytail: one page; paginate past 200
    canCreate: ["inventory.adjust_create", "inventory.damage_mark"].some((p) => ctx.permissions.has(p)),
  }));
  if ("denied" in res) return <Denied message={res.denied} />;
  const { list, canCreate } = res.data;
  return (
    <div className="flex max-w-6xl flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="h1">Adjustments, damage &amp; disposal</h1>
        {canCreate && <Link href="/adjustments/new" className="btn-primary">New</Link>}
      </div>
      <form className="flex flex-wrap items-end gap-3" role="search">
        <label className="label">Search<input name="q" defaultValue={q} placeholder="ADJ number" className="input" /></label>
        <label className="label">
          Kind
          <select name="kind" defaultValue={kind ?? ""} className="input"><option value="">All</option>{KINDS.map((k) => <option key={k}>{k}</option>)}</select>
        </label>
        <label className="label">
          Status
          <select name="status" defaultValue={status ?? ""} className="input"><option value="">All</option>{STATUSES.map((s) => <option key={s}>{s}</option>)}</select>
        </label>
        <button className="btn">Filter</button>
      </form>
      <div className="card overflow-x-auto p-0">
        <table className="table">
          <thead><tr><th>Number</th><th>Kind</th><th>Warehouse</th><th>Reason</th><th>Status</th><th className="text-right">Lines</th><th>Created</th></tr></thead>
          <tbody>
            {list.items.length === 0 && <tr><td colSpan={7} className="text-muted">Nothing here.</td></tr>}
            {list.items.map((a) => (
              <tr key={a.id}>
                <td><Link href={`/adjustments/${a.id}`} className="link font-mono text-xs">{a.number}</Link></td>
                <td>{a.kind}</td>
                <td>{a.warehouse.code}</td>
                <td>{a.reasonCode}</td>
                <td>{a.status}</td>
                <td className="text-right tabular-nums">{a._count.lines}</td>
                <td>{a.createdAt.toISOString().slice(0, 10)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
