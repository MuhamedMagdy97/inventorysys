import type { Metadata } from "next";
import Link from "next/link";
import type { TransferStatus } from "@/generated/prisma/client";
import { Denied } from "@/app/ui/denied";
import { pageData } from "@/server/auth/page-ctx";
import { listTransfers } from "@/server/inventory/transfers";

export const metadata: Metadata = { title: "Transfers" };

const STATUSES: TransferStatus[] = ["draft", "submitted", "approved", "in_transit", "partially_received", "completed", "closed_with_variance", "cancelled"];
const label = (s: string) => s.replaceAll("_", " ");

export default async function TransfersPage({ searchParams }: PageProps<"/transfers">) {
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q : undefined;
  const status = STATUSES.find((s) => s === sp.status);
  const res = await pageData(async (ctx) => ({
    list: await listTransfers(ctx, { page: 1, perPage: 200, q, status }), // ponytail: one page; paginate past 200
    canCreate: ctx.permissions.has("inventory.transfer_create"),
  }));
  if ("denied" in res) return <Denied message={res.denied} />;
  const { list, canCreate } = res.data;
  return (
    <div className="flex max-w-6xl flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="h1">Transfers</h1>
        {canCreate && <Link href="/transfers/new" className="btn-primary">New transfer</Link>}
      </div>
      <form className="flex flex-wrap items-end gap-3" role="search">
        <label className="label">Search<input name="q" defaultValue={q} placeholder="TR number" className="input" /></label>
        <label className="label">
          Status
          <select name="status" defaultValue={status ?? ""} className="input">
            <option value="">All</option>
            {STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}
          </select>
        </label>
        <button className="btn">Filter</button>
      </form>
      <div className="card overflow-x-auto p-0">
        <table className="table">
          <thead><tr><th>Transfer</th><th>From → to</th><th>Status</th><th className="text-right">Lines</th><th>Created</th></tr></thead>
          <tbody>
            {list.items.length === 0 && <tr><td colSpan={5} className="text-muted">No transfers.</td></tr>}
            {list.items.map((t) => (
              <tr key={t.id}>
                <td><Link href={`/transfers/${t.id}`} className="link font-mono text-xs">{t.number}</Link></td>
                <td>{t.fromWarehouse.code} → {t.toWarehouse.code}</td>
                <td>{label(t.status)}</td>
                <td className="text-right tabular-nums">{t._count.lines}</td>
                <td>{t.createdAt.toISOString().slice(0, 10)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
